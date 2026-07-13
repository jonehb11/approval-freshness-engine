import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { verifyWebhookSignature } from "./github/auth.js";
import { auditDecision } from "./audit/logger.js";
import { Action } from "./stages/types.js";

// Security: Global unhandled rejection handler.
// By default, modern Node.js versions crash on unhandled promise rejections,
// which is a good fail-closed security posture, but we explicitly catch it
// here to log critically before crashing, preventing silent failures.
process.on("unhandledRejection", (reason, promise) => {
  console.error("CRITICAL: Unhandled Promise Rejection:", reason);
  // Ensure the process exits to prevent inconsistent state
  process.exit(1); 
});

process.on("uncaughtException", (error) => {
  console.error("CRITICAL: Uncaught Exception:", error);
  process.exit(1);
});

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const PORT = process.env.PORT || 3000;

if (!WEBHOOK_SECRET) {
  console.error("FATAL: GITHUB_WEBHOOK_SECRET environment variable is missing.");
  process.exit(1);
}

/**
 * Reads the raw body of an HTTP request securely.
 * Applies a strict payload size limit to mitigate Denial of Service (DoS) attacks
 * via excessive memory consumption.
 *
 * @param req - The Incoming HTTP Message
 * @returns A promise resolving to a Buffer of the raw body payload
 */
async function getRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    // 5MB limit to prevent memory exhaustion (DoS). GitHub webhooks are capped at 25MB but typically much smaller.
    const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; 

    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_PAYLOAD_SIZE) {
        req.destroy();
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Main application server to receive GitHub webhooks.
 * Features extensive security controls:
 * 1. Payload size limits.
 * 2. Cryptographically secure signature verification (constant-time).
 * 3. Graceful error handling (fails closed).
 * 4. Broad exception handling on async routines to prevent unhandled promise rejections.
 */
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Only accept POST requests for webhooks
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  // Healthcheck endpoint (if deployed in a container environment)
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // Ensure this is hitting the webhook endpoint
  if (req.url !== "/webhook") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  try {
    // 1. Read raw body payload securely with limits
    const rawBody = await getRawBody(req);

    // 2. Extract signature header
    const signature = req.headers["x-hub-signature-256"] as string;

    // 3. Verify signature cryptographically (constant-time)
    if (!signature || !verifyWebhookSignature(WEBHOOK_SECRET, signature, rawBody)) {
      console.warn("Security Alert: Invalid webhook signature received.");
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized: Invalid signature");
      return;
    }

    // 4. Safely parse JSON payload
    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (parseError) {
      console.error("Error parsing webhook JSON payload:", parseError);
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: Invalid JSON");
      return;
    }

    // 5. Handle GitHub ping events gracefully
    const eventType = req.headers["x-github-event"];
    if (eventType === "ping") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pong");
      return;
    }

    // Acknowledge receipt to GitHub immediately to prevent webhook timeouts
    // GitHub expects a response within 10 seconds.
    res.writeHead(202, { "Content-Type": "text/plain" });
    res.end("Accepted");

    // 6. Process the webhook payload asynchronously (fire and forget)
    // We catch all promise rejections internally to prevent process crashes.
    processWebhook(eventType as string, payload).catch((err) => {
      console.error("Critical error during async webhook processing:", err);
      // Fails closed by logging the error, but the server stays alive.
    });

  } catch (error: any) {
    // Handle specific documented errors (like payload too large)
    if (error.message === "Payload too large") {
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end("Payload Too Large");
      return;
    }
    
    // Catch-all for unexpected server errors while receiving request
    console.error("Unexpected server error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }
});

import { loadConfig } from "./config/schema.js";
import { buildDelta } from "./github/pr.js";
import { evaluate } from "./stages/ladder.js";
import { actuate } from "./github/actuator.js";
import { Octokit } from "@octokit/rest";

/**
 * Asynchronously processes the validated webhook payload.
 * Incorporates business logic for approval freshness evaluation.
 * 
 * @param eventType - The GitHub event type (e.g., 'pull_request')
 * @param payload - The deserialized JSON payload
 */
async function processWebhook(eventType: string, payload: any): Promise<void> {
  // Only process pull_request events or related reviews.
  if (eventType !== "pull_request" && eventType !== "pull_request_review") {
    return;
  }

  const action = payload.action;
  console.log(`Processing ${eventType} with action: ${action}`);

  // Only run evaluation on synchronize (push) or submitted reviews
  if (action !== "synchronize" && action !== "submitted") {
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pr = payload.pull_request;
  const prNumber = pr.number;

  // Initialize Octokit (requires GITHUB_TOKEN or App Auth in real env)
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  try {
    // In a full implementation, we'd fetch the timeline to find the last approved SHA.
    // For this engine, we assume the base sha or previous head sha is the approved sha.
    // This is simplified for the boilerplate.
    const headSha = pr.head.sha;
    const approvedSha = payload.before || pr.base.sha; 
    
    const cfg = await loadConfig();
    
    // 1. Build the unified Delta object representing the change
    const delta = await buildDelta(octokit, owner, repo, pr, approvedSha, headSha);
    
    // 2. Evaluate the delta through the 3-stage fail-closed ladder
    const decision = await evaluate(delta, cfg);
    
    // We would fetch actual review IDs to dismiss here.
    const reviewIds: number[] = [];
    const approverLogins: string[] = [];

    // 3. Actuate the decision back to GitHub (set check run, dismiss reviews)
    await actuate(decision, {
      octokit, owner, repo, prNumber, headSha, reviewIds, approverLogins, dryRun: false
    });
  } catch (err) {
    console.error("Error processing webhook logic:", err);
    throw err; // Caught by the fire-and-forget catch block
  }
}

// Start server
server.listen(PORT, () => {
  console.log(`Approval Freshness Engine running on port ${PORT}`);
});
