import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { pathToFileURL } from "node:url";
import { verifyWebhookSignature } from "./github/auth.js";
import { handleFreshApproval } from "./github/freshApproval.js";
import { setCheckPending } from "./github/actuator.js";
import { getOctokit } from "./github/client.js";
import { WorkQueue } from "./runtime/queue.js";
import { createMetrics, queueMetricsHooks, sampleQueueGauges, Metrics } from "./observability/metrics.js";

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
        // Stop consuming but do NOT destroy the socket here: req and res share it, so an
        // immediate destroy would kill the connection before the 413 response could ever be
        // written (the client would see ECONNRESET instead of the intended status). The
        // 413-handling branch in handleRequest responds first, then tears the socket down.
        req.pause();
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

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Small, bounded allowlist for the `event` label on afe_webhooks_total.
// Security: X-GitHub-Event is attacker-controlled on any request that reaches this handler —
// notably on a BAD-SIGNATURE request, where nothing about the request has been authenticated
// yet. Using the raw header value as a Prometheus label would let an attacker mint unbounded
// distinct label values (a metrics-cardinality DoS against /metrics and whatever scrapes it)
// just by spraying junk X-GitHub-Event headers. Collapsing anything outside this small known
// set to "other" keeps the label space bounded regardless of input.
const KNOWN_EVENT_LABELS = new Set(["pull_request", "pull_request_review", "ping"]);
function normalizeEventLabel(eventType: string | undefined | null): string {
  return eventType && KNOWN_EVENT_LABELS.has(eventType) ? eventType : "other";
}

interface RequestContext {
  webhookSecret: string;
  queue: WorkQueue;
  metrics: Metrics;
  isReady: () => boolean;
}

/**
 * Main application request handler for the webhook server.
 * Features extensive security controls:
 * 1. Payload size limits.
 * 2. Cryptographically secure signature verification (constant-time).
 * 3. Graceful error handling (fails closed).
 * 4. Broad exception handling on async routines to prevent unhandled promise rejections.
 *
 * Routing order (bug fix — probes used to 405): GET liveness/readiness/metrics endpoints are handled BEFORE the
 * POST-only gate. Previously ALL non-POST requests (including Kubernetes' GET probes) were
 * rejected with 405 before the health check was ever reached, so pods never became Ready.
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  if (req.method === "GET") {
    // Liveness: process is up and the event loop is responsive. Never depends on readiness,
    // downstream GitHub reachability, or queue state — that's what /readyz is for.
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    // Readiness: 200 while accepting new work, 503 once graceful shutdown has begun. A load
    // balancer / Kubernetes Service should stop routing new traffic here on the 503 transition.
    if (req.url === "/readyz") {
      if (ctx.isReady()) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ready");
      } else {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("shutting down");
      }
      return;
    }

    if (req.url === "/metrics") {
      sampleQueueGauges(ctx.metrics, ctx.queue.stats());
      res.writeHead(200, { "Content-Type": ctx.metrics.register.contentType });
      res.end(await ctx.metrics.register.metrics());
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  // Only accept POST requests beyond this point (webhook delivery).
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
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
    if (!signature || !verifyWebhookSignature(ctx.webhookSecret, signature, rawBody)) {
      console.warn("Security Alert: Invalid webhook signature received.");
      const rawEvent = req.headers["x-github-event"] as string | undefined;
      ctx.metrics.webhooksTotal.labels(normalizeEventLabel(rawEvent), "bad_signature").inc();
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
      // Note: this request PASSED signature verification, so a bad_json spike means either a
      // GitHub payload-format surprise or someone in possession of the webhook secret sending
      // garbage — both worth seeing on a dashboard.
      const rawEvent = req.headers["x-github-event"] as string | undefined;
      ctx.metrics.webhooksTotal.labels(normalizeEventLabel(rawEvent), "bad_json").inc();
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: Invalid JSON");
      return;
    }

    const eventType = req.headers["x-github-event"] as string | undefined;
    // Structured log field (not a new logger framework): every log line for this delivery, in
    // the request handler and inside its queued task, is tagged with this id so a single PR's
    // processing can be grepped end-to-end across the async boundary.
    const deliveryId = (req.headers["x-github-delivery"] as string | undefined) || "unknown";

    // 5. Handle GitHub ping events gracefully
    if (eventType === "ping") {
      ctx.metrics.webhooksTotal.labels("ping", "ignored").inc();
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pong");
      return;
    }

    // Acknowledge receipt to GitHub immediately to prevent webhook timeouts
    // GitHub expects a response within 10 seconds.
    res.writeHead(202, { "Content-Type": "text/plain" });
    res.end("Accepted");

    // 6. Enqueue the validated event for asynchronous processing (fire and forget from the
    // handler's point of view — enqueue() itself never throws). Both event kinds below key on
    // `${owner}/${repo}#${prNumber}` so they SERIALIZE per PR (never race the ladder evaluation
    // against the fresh-approval echo for the same PR) and COALESCE per PR (a later push
    // supersedes an earlier one — see src/runtime/queue.ts for why that's safe).
    enqueueWebhookEvent(eventType, payload, deliveryId, ctx);

  } catch (error: any) {
    // Handle specific documented errors (like payload too large)
    if (error.message === "Payload too large") {
      // Observability parity with the bad_signature path: an oversized payload is an abuse
      // signal (probing the 5MB limit) and must be visible in logs AND metrics, not silent.
      const rawEvent = req.headers["x-github-event"] as string | undefined;
      console.warn(`Security Alert: Oversized webhook payload rejected (event=${normalizeEventLabel(rawEvent)}).`);
      ctx.metrics.webhooksTotal.labels(normalizeEventLabel(rawEvent), "payload_too_large").inc();
      // Respond BEFORE tearing down: getRawBody paused (not destroyed) the request stream so
      // this 413 can actually reach the client; Connection: close + the post-flush destroy
      // then drop the connection so the client cannot keep streaming the rest of the body.
      res.writeHead(413, { "Content-Type": "text/plain", "Connection": "close" });
      res.end("Payload Too Large", () => req.destroy());
      return;
    }

    // Catch-all for unexpected server errors while receiving request
    console.error("Unexpected server error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }
}

/**
 * Decides what (if anything) a validated, signature-verified webhook delivery should do, and
 * enqueues it. This function itself is synchronous and never touches GitHub — the actual work
 * (and all its `await`s) lives inside the task closures handed to queue.enqueue(), which the
 * queue runs later under per-key serialization and the global concurrency bound.
 */
function enqueueWebhookEvent(eventType: string | undefined, payload: any, deliveryId: string, ctx: RequestContext): void {
  const label = normalizeEventLabel(eventType);

  if (eventType !== "pull_request" && eventType !== "pull_request_review") {
    ctx.metrics.webhooksTotal.labels(label, "ignored").inc();
    return;
  }

  const action = payload?.action;

  // pull_request_review "submitted" is the fresh-approval echo's ONLY trigger (see
  // src/github/freshApproval.ts for the full precondition table): a platform-verified human
  // approval on the exact current head SHA is the re-review the required check exists to gate
  // on. This is wired for real (not a stub) because it is the engine's primary unblock path now
  // that there is no dead-man switch or ruleset-write credential anywhere in the system — see
  // README.md "End-to-End Flow & Fail-Safe Mechanics".
  if (eventType === "pull_request_review" && action === "submitted") {
    const owner = payload?.repository?.owner?.login;
    const repo = payload?.repository?.name;
    const prNumber = payload?.pull_request?.number;
    if (!owner || !repo || typeof prNumber !== "number") {
      // Malformed/unexpected payload shape: fail closed by no-op'ing rather than throwing
      // partway through GitHub API calls with undefined coordinates.
      console.error(`[${deliveryId}] pull_request_review payload missing repository/PR coordinates; skipping.`);
      ctx.metrics.webhooksTotal.labels(label, "ignored").inc();
      return;
    }

    const key = `${owner}/${repo}#${prNumber}`;
    ctx.metrics.webhooksTotal.labels(label, "verified").inc();
    const accepted = ctx.queue.enqueue(key, async () => {
      console.log(`[${deliveryId}] key=${key} processing pull_request_review submitted`);
      // Real deployment authenticates as the GitHub App installation (integration_id
      // pinning requires this exact App identity — no other credential can satisfy the required
      // check). GITHUB_TOKEN here is an installation/app token minted by the deploy
      // environment; src/github/auth.ts currently only covers webhook signature verification,
      // so token minting is intentionally left to the deploy-time wiring, consistent with this
      // repo's "Build honesty" stance on what is and isn't implemented yet (see loadConfig()).
      // getOctokit() caches per token value (see src/github/client.ts); passing GITHUB_TOKEN
      // explicitly here (rather than relying on an internal default) keeps this call site
      // correct regardless of that module's own default-token behavior.
      const octokit = getOctokit(process.env.GITHUB_TOKEN);
      await handleFreshApproval(payload, {
        octokit, owner, repo,
        dryRun: process.env.DRY_RUN === "true",
      });
    }, { kind: "fresh_approval", deliveryId });

    if (!accepted) {
      // Fail-closed: the webhook was already 202'd, so a dropped task just leaves the check
      // missing (blocks merge) rather than crashing anything. Reconciliation on the next
      // webhook, or a later fresh, current-head approval, recovers the PR.
      console.warn(`[${deliveryId}] key=${key} queue overflow: pull_request_review task dropped.`);
    }
    return;
  }

  // On push receipt (pull_request "synchronize"), immediately mark the check in_progress on
  // the new head SHA. This is UX-only, not a safety mechanism (a new SHA never inherits a
  // prior SHA's success — required checks match per head SHA — and in_progress is itself a
  // non-passing state either way) — it tells developers "the engine saw your push and is
  // evaluating" instead of an opaque missing check.
  if (eventType === "pull_request" && action === "synchronize") {
    const owner = payload?.repository?.owner?.login;
    const repo = payload?.repository?.name;
    const prNumber = payload?.pull_request?.number;
    const headSha = payload?.pull_request?.head?.sha;
    if (!owner || !repo || typeof prNumber !== "number" || typeof headSha !== "string" || headSha === "") {
      console.error(`[${deliveryId}] pull_request synchronize payload missing repository/PR/head coordinates; skipping.`);
      ctx.metrics.webhooksTotal.labels(label, "ignored").inc();
      return;
    }

    const key = `${owner}/${repo}#${prNumber}`;
    ctx.metrics.webhooksTotal.labels(label, "verified").inc();
    const accepted = ctx.queue.enqueue(key, async () => {
      console.log(`[${deliveryId}] key=${key} processing pull_request synchronize`);
      const octokit = getOctokit(process.env.GITHUB_TOKEN);
      await setCheckPending({ octokit, owner, repo, headSha, dryRun: process.env.DRY_RUN === "true" });
      // Fall through intentionally ends here for now: the delta evaluation itself is the
      // implementation stub below (ladder + actuator wiring at deploy time).
      // Implementation stub for all other pull_request / pull_request_review actions:
      // Usually this would fetch the PR delta, evaluate it through stages,
      // and then use the Actuator to preserve or dismiss approvals.
      // In a real implementation we would invoke evaluate() from src/stages/ladder.ts
      // and actuate() from src/github/actuator.ts
    }, { kind: "synchronize", deliveryId });

    if (!accepted) {
      console.warn(`[${deliveryId}] key=${key} queue overflow: pull_request synchronize task dropped.`);
    }
    return;
  }

  // Any other pull_request / pull_request_review action is implementation-stub territory: no-op.
  ctx.metrics.webhooksTotal.labels(label, "ignored").inc();
}

export interface Engine {
  server: Server;
  queue: WorkQueue;
  /** Flips readiness to unready, stops accepting new connections, and drains the queue (bounded
   * by AFE_SHUTDOWN_GRACE_MS). Never calls process.exit — that decision belongs to the caller
   * (see the SIGTERM/SIGINT/unhandledRejection wiring below), which keeps this safely callable
   * from tests. */
  shutdown: () => Promise<void>;
}

/**
 * Builds a fully-wired engine (server + queue + metrics + graceful shutdown) without binding a
 * port or touching process-wide signal handlers, so tests can exercise routes in isolation.
 * Module-level auto-listen (and process signal wiring) only happens when this file is run as
 * main — see the bottom of this file.
 */
export function createEngine(): Engine {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || "";
  if (!webhookSecret) {
    // Security: refuse to build a server that cannot verify webhook signatures. Relocated from
    // the old module-level check into the factory itself so createEngine() is the single source
    // of truth, and so it stays synchronously testable (callers, including tests, control
    // GITHUB_WEBHOOK_SECRET before invoking this rather than at module-import time).
    throw new Error("FATAL: GITHUB_WEBHOOK_SECRET environment variable is missing.");
  }

  const shutdownGraceMs = envInt("AFE_SHUTDOWN_GRACE_MS", 25000);
  const metrics = createMetrics();
  const queue = new WorkQueue({ hooks: queueMetricsHooks(metrics) });

  // Readiness gate: true while accepting new work, flipped BEFORE the drain even starts so a
  // load balancer stops routing new traffic here the instant shutdown begins.
  let ready = true;
  let shuttingDown = false;

  const server = createServer((req, res) => {
    // Thin structured access log: one line per request with method/path/status/latency, so
    // "what did this server receive and how did it respond" is greppable in one place across
    // all routes. Healthy probe/scrape traffic (2xx on the three GET operational endpoints,
    // every few seconds from kubelet + Prometheus) is suppressed to keep logs signal-dense;
    // any non-2xx on those paths still logs.
    const startedAt = Date.now();
    res.on("finish", () => {
      const operational = req.method === "GET" &&
        (req.url === "/healthz" || req.url === "/readyz" || req.url === "/metrics");
      if (operational && res.statusCode < 300) return;
      console.log(JSON.stringify({
        ts: new Date().toISOString(), kind: "http_access",
        method: req.method, path: req.url, status: res.statusCode,
        durationMs: Date.now() - startedAt,
        deliveryId: (req.headers["x-github-delivery"] as string | undefined) ?? null,
      }));
    });
    handleRequest(req, res, { webhookSecret, queue, metrics, isReady: () => ready }).catch((err) => {
      console.error("Unexpected error in request handler:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    });
  });

  // ALB/ELB idle-timeout compatibility: keepAliveTimeout must exceed the load balancer's idle
  // timeout (commonly 60s) or the LB can send a request on a connection the server just closed,
  // causing intermittent 502s; headersTimeout must in turn exceed keepAliveTimeout (Node
  // requirement). requestTimeout bounds how long a single request may take end-to-end.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 30000;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; // idempotent: SIGTERM+SIGINT (or repeated signals) racing
    shuttingDown = true;
    ready = false;
    console.error("[shutdown] readiness flipped to unready; draining in-flight work");

    // Drain BEFORE closing the listener, not after: Node's http server resets (not gracefully
    // finishes) idle keep-alive sockets as soon as server.close() runs, which makes the port
    // functionally unreachable within the same tick — an ALB/ingress health check hitting
    // /readyz during that window would see a connection failure, not the 503 this readiness
    // gate exists to serve. The Helm probe wiring (and the lack of a preStop sleep — distroless has
    // no shell) relies on /readyz staying reachable and returning 503 throughout the drain
    // window, so the listener stays open for that duration; new POSTs during this window are
    // harmless (queue.enqueue() below already refuses new work once draining, so they just no-op
    // fail-closed the same as an overflow — see src/runtime/queue.ts).
    await queue.drain(shutdownGraceMs);

    await new Promise<void>((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
    });
    // Undrained work here is fail-closed BY CONSTRUCTION: a task that never finished simply
    // never sets its PR's check, so the required check stays missing and merge stays blocked.
    // Reconciliation on the next webhook, or a fresh current-head approval (the echo path),
    // recovers the PR — so the grace period only needs to be generous, not guaranteed.
    console.error("[shutdown] drain complete, server closed");
  };

  return { server, queue, shutdown };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return !!entry && import.meta.url === pathToFileURL(entry).href;
}

async function gracefulShutdown(engine: Engine, exitCode: number): Promise<void> {
  let code = exitCode;
  try {
    await engine.shutdown();
  } catch (err) {
    console.error("CRITICAL: error during graceful shutdown:", err);
    code = 1;
  } finally {
    process.exit(code);
  }
}

if (isMainModule()) {
  const PORT = process.env.PORT || 3000;

  let engine: Engine;
  try {
    engine = createEngine();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Security: Global unhandled rejection handler. By default, modern Node.js versions crash on
  // unhandled promise rejections, which is a good fail-closed security posture, but we
  // explicitly catch it here to log CRITICAL and initiate the SAME graceful (bounded) shutdown
  // as SIGTERM, rather than killing in-flight work instantly — a task interrupted mid-write is
  // no safer than one given a chance to finish, and the drain is itself bounded
  // (AFE_SHUTDOWN_GRACE_MS) so this can never hang the process.
  process.on("unhandledRejection", (reason) => {
    console.error("CRITICAL: Unhandled Promise Rejection:", reason);
    void gracefulShutdown(engine, 1);
  });

  process.on("uncaughtException", (error) => {
    console.error("CRITICAL: Uncaught Exception:", error);
    // No drain attempt here: an uncaught exception means process state is unknown, so exit
    // immediately rather than risk running more code (including the drain's own await chain) in
    // a possibly-corrupted state. Fail-closed: undrained work just leaves checks missing.
    process.exit(1);
  });

  process.on("SIGTERM", () => {
    console.error("[shutdown] received SIGTERM");
    void gracefulShutdown(engine, 0);
  });
  process.on("SIGINT", () => {
    console.error("[shutdown] received SIGINT");
    void gracefulShutdown(engine, 0);
  });

  engine.server.listen(PORT, () => {
    console.log(`Approval Freshness Engine running on port ${PORT}`);
  });
}
