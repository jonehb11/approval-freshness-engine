import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Octokit } from "@octokit/rest";
import { verifyWebhookSignature } from "./github/auth.js";
import { auditDecision } from "./audit/logger.js";
import { Action } from "./stages/types.js";
import { handleFreshApproval } from "./github/freshApproval.js";
import { setCheckPending } from "./github/actuator.js";

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

  // pull_request_review "submitted" is the fresh-approval echo's ONLY trigger (see
  // src/github/freshApproval.ts for the full precondition table):
  // a platform-verified human approval on the exact current head SHA is the re-review the
  // required check exists to gate on. This is wired for real (not a stub) because it is the
  // engine's primary unblock path now that there is no dead-man switch or ruleset-write
  // credential anywhere in the system — see README.md "End-to-End Flow & Fail-Safe Mechanics".
  if (eventType === "pull_request_review" && action === "submitted") {
    const owner = payload?.repository?.owner?.login;
    const repo = payload?.repository?.name;
    if (!owner || !repo) {
      // Malformed/unexpected payload shape: fail closed by no-op'ing rather than throwing
      // partway through GitHub API calls with undefined coordinates.
      console.error("pull_request_review payload missing repository owner/name; skipping.");
      return;
    }

    // Real deployment authenticates as the GitHub App installation (integration_id pinning,
    // F2, requires this exact App identity — no other credential can satisfy the required
    // check). GITHUB_TOKEN here is an installation/app token minted by the deploy environment;
    // src/github/auth.ts currently only covers webhook signature verification, so token
    // minting is intentionally left to the deploy-time wiring, consistent with this repo's
    // "Build honesty" stance on what is and isn't implemented yet (see loadConfig()).
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

    await handleFreshApproval(payload, {
      octokit, owner, repo,
      dryRun: process.env.DRY_RUN === "true",
    });
    return;
  }

  // On push receipt (pull_request "synchronize"), immediately mark the check in_progress on
  // the new head SHA. This is UX-only, not a safety mechanism (a new SHA never inherits a
  // prior SHA's success — required checks match per head SHA — and in_progress is itself a
  // non-passing state either way) — it tells
  // developers "the engine saw your push and is evaluating" instead of an opaque missing check.
  if (eventType === "pull_request" && action === "synchronize") {
    const owner = payload?.repository?.owner?.login;
    const repo = payload?.repository?.name;
    const headSha = payload?.pull_request?.head?.sha;
    if (!owner || !repo || typeof headSha !== "string" || headSha === "") {
      console.error("pull_request synchronize payload missing repository/head coordinates; skipping.");
      return;
    }
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    await setCheckPending({ octokit, owner, repo, headSha, dryRun: process.env.DRY_RUN === "true" });
    // Fall through intentionally ends here for now: the delta evaluation itself is the
    // implementation stub below (ladder + actuator wiring at deploy time).
  }

  // Implementation stub for all other pull_request / pull_request_review actions:
  // Usually this would fetch the PR delta, evaluate it through stages,
  // and then use the Actuator to preserve or dismiss approvals.
  // In a real implementation we would invoke evaluate() from src/stages/ladder.ts
  // and actuate() from src/github/actuator.ts
}

// Start server
server.listen(PORT, () => {
  console.log(`Approval Freshness Engine running on port ${PORT}`);
});
