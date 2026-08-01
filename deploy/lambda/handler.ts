import { Octokit } from "@octokit/rest";
import { verifyWebhookSignature } from "../../src/github/auth.js";
import { getInstallationToken } from "../../src/github/appAuth.js";
import { handleFreshApproval } from "../../src/github/freshApproval.js";
import { evaluateSynchronize, publishPendingCheck } from "../../src/engine.js";

/**
 * AWS Lambda adapter — the engine's webhook receiver when deployed behind a Function URL
 * instead of as a long-running pod.
 *
 * WHY THERE IS NO WORK QUEUE HERE
 * src/runtime/queue.ts exists because a pod receives many deliveries into one process and must
 * serialize per PR and coalesce superseded pushes. Lambda's execution model already provides the
 * first property differently — one delivery per invocation — and the second is unnecessary: check
 * runs are matched per head SHA, and every write this engine performs is idempotent for a given
 * (PR, SHA), so a superseded evaluation writes a result for a SHA that no longer gates anything.
 * Concurrent invocations for the same PR can therefore race only to write the same conclusion on
 * different SHAs, which is exactly what the per-SHA matching rule already resolves.
 *
 * The invocation MUST await all work before returning: Lambda freezes the execution environment
 * the moment the handler resolves, so a floating promise would be suspended mid-write and the
 * check would never be written — leaving the merge blocked (safe, but silently wrong).
 *
 * FAIL-CLOSED CONTRACT
 * Bad signature → 401 and no work. Any thrown error during processing → 500 with nothing
 * written beyond whatever already succeeded; the required check stays non-passing and the merge
 * stays blocked. No path here writes check success except the two legitimate producers reached
 * through evaluateSynchronize (a PRESERVE verdict) and handleFreshApproval (the echo).
 */

interface FunctionUrlEvent {
  requestContext?: { http?: { method?: string; path?: string } };
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

const INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;

// Cold-start banner: which build is actually serving, and whether the difftastic binary the
// deterministic preserve path depends on is present and executable. Without this, a layer that
// failed to attach looks identical to "no changes were provably null" — the engine keeps
// answering, just never preserves anything.
(() => {
  const bin = process.env.DIFFT_BIN || "difft";
  let difft = "missing";
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { statSync, accessSync, constants } = require("node:fs");
    statSync(bin);
    accessSync(bin, constants.X_OK);
    difft = "ok";
  } catch (e: any) {
    difft = `unusable (${e?.code ?? "err"})`;
  }
  console.log(`[boot] afe build=${process.env.AFE_BUILD ?? "unset"} difftBin=${bin} difft=${difft} stage2=${process.env.AFE_STAGE2_ENABLED ?? "config"}`);
})();

function reply(statusCode: number, body: string): LambdaResponse {
  return { statusCode, headers: { "Content-Type": "text/plain" }, body };
}

/**
 * Octokit authenticated as the engine's GitHub App installation. The App identity is not an
 * implementation detail here — the ruleset pins the required check to it, so a check written
 * with any other credential cannot satisfy the gate.
 */
async function appOctokit(installationId: number): Promise<Octokit> {
  const token = await getInstallationToken(installationId);
  return new Octokit({ auth: token, request: { timeout: 10_000 } });
}

export async function handler(event: FunctionUrlEvent): Promise<LambdaResponse> {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";

  if (method === "GET") {
    // Liveness only. Deliberately NOT a GitHub reachability check: this endpoint exists so an
    // operator can see the function is deployed, not to gate anything.
    if (path === "/healthz" || path === "/") return reply(200, "ok");
    return reply(404, "Not Found");
  }
  if (method !== "POST") return reply(405, "Method Not Allowed");

  const secret = process.env.GITHUB_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "";
  if (!secret) {
    // Refuse to process anything we cannot authenticate. Fail closed.
    console.error("FATAL: webhook secret is not configured");
    return reply(500, "Server misconfigured");
  }

  // The HMAC must be computed over the EXACT bytes GitHub signed. Re-serializing parsed JSON
  // would change whitespace/ordering and break verification, so the raw buffer is used and only
  // then parsed.
  const raw = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
  const signature = event.headers?.["x-hub-signature-256"] ?? event.headers?.["X-Hub-Signature-256"] ?? "";

  if (!verifyWebhookSignature(secret, signature, raw)) {
    console.warn("Security Alert: invalid webhook signature.");
    return reply(401, "Unauthorized: Invalid signature");
  }

  const eventType = event.headers?.["x-github-event"] ?? event.headers?.["X-GitHub-Event"] ?? "";
  const deliveryId = event.headers?.["x-github-delivery"] ?? "unknown";

  if (eventType === "ping") return reply(200, "pong");

  let payload: any;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return reply(400, "Bad Request: Invalid JSON");
  }

  const owner = payload?.repository?.owner?.login;
  const repo = payload?.repository?.name;
  const prNumber = payload?.pull_request?.number;
  const action = payload?.action;

  if (!owner || !repo || typeof prNumber !== "number") {
    console.log(`[${deliveryId}] event=${eventType} action=${action}: no PR coordinates; ignoring.`);
    return reply(202, "Accepted (ignored)");
  }

  const installationId = Number(payload?.installation?.id ?? INSTALLATION_ID);
  if (!Number.isFinite(installationId) || installationId <= 0) {
    console.error(`[${deliveryId}] no installation id on payload and GITHUB_INSTALLATION_ID unset; cannot authenticate as the App.`);
    return reply(500, "No installation id");
  }

  const dryRun = process.env.DRY_RUN === "true";

  try {
    const octokit = await appOctokit(installationId);

    if (eventType === "pull_request_review" && action === "submitted") {
      // The fresh-approval echo — the second (and only other) producer of check success.
      await handleFreshApproval(payload, { octokit, owner, repo, dryRun });
      return reply(202, "Accepted");
    }

    if (eventType === "pull_request") {
      const headSha = payload?.pull_request?.head?.sha;
      if (typeof headSha !== "string" || !headSha) {
        return reply(202, "Accepted (no head sha)");
      }

      if (action === "opened" || action === "reopened" || action === "ready_for_review") {
        // UX-only: in_progress is a non-passing status, so this can never satisfy the gate.
        await publishPendingCheck({ octokit, owner, repo, headSha, dryRun, action });
        return reply(202, "Accepted");
      }

      if (action === "synchronize") {
        await publishPendingCheck({ octokit, owner, repo, headSha, dryRun, action });
        const result = await evaluateSynchronize({
          octokit, owner, repo, prNumber, headSha, dryRun, deliveryId,
        });
        console.log(`[${deliveryId}] ${owner}/${repo}#${prNumber} outcome=${result.outcome} reason=${result.reason ?? "-"}`);
        return reply(202, `Accepted (${result.outcome})`);
      }
    }

    return reply(202, "Accepted (ignored)");
  } catch (err: any) {
    // Fail closed: nothing further is written, so the required check keeps whatever non-passing
    // state it had and the merge stays blocked. A 500 also makes GitHub mark the delivery failed,
    // which is visible in the App's delivery log and redeliverable by a human.
    console.error(`[${deliveryId}] processing error:`, err?.message ?? err);
    return reply(500, "Processing error");
  }
}
