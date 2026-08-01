import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";

const WEBHOOK_SECRET = "test-webhook-secret";

// The whole GitHub-write surface is faked here so these tests never make a real network call
// (fast, deterministic, no dependency on network access in CI/sandbox). This mocks the SAME
// module path src/index.ts imports (src/github/client.js), and the one src/github/actuator.ts
// imports withRateLimit from, so both call chains (fresh-approval echo and setCheckPending)
// resolve instantly against the fake.
const fakeOctokit = {
  checks: {
    create: vi.fn().mockResolvedValue({}),
    // Read used only by the PR-lifecycle clobber guard (opened/reopened/ready_for_review):
    // default is "no existing runs", so the pending write proceeds. Individual tests override
    // with mockResolvedValueOnce to simulate a pre-existing completed success.
    listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
  },
  pulls: { dismissReview: vi.fn().mockResolvedValue({}), requestReviewers: vi.fn().mockResolvedValue({}) },
  issues: { createComment: vi.fn().mockResolvedValue({}) },
} as any;

vi.mock("../src/github/client.js", () => ({
  getOctokit: () => fakeOctokit,
  withRateLimit: async (fn: () => Promise<any>) => fn(),
}));

beforeAll(() => {
  // createEngine() reads this at call time (not at module-import time), so setting it here,
  // before any test calls createEngine(), is sufficient — see src/index.ts's factory comment.
  process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type EngineHandle = Awaited<ReturnType<typeof startEngine>>;

async function startEngine() {
  const { createEngine } = await import("../src/index.js");
  const engine = createEngine();
  await new Promise<void>((resolve) => engine.server.listen(0, resolve));
  const { port } = engine.server.address() as AddressInfo;
  return { engine, baseUrl: `http://127.0.0.1:${port}` };
}

const openEngines: EngineHandle[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  while (openEngines.length) {
    const { engine } = openEngines.pop()!;
    await new Promise<void>((resolve) => {
      if (!engine.server.listening) { resolve(); return; }
      engine.server.close(() => resolve());
    });
  }
});

describe("createEngine()", () => {
  it("returns {server, queue, shutdown} without requiring listen()", () => {
    const original = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    return import("../src/index.js").then(({ createEngine }) => {
      const engine = createEngine();
      expect(engine.server).toBeDefined();
      expect(typeof engine.queue.enqueue).toBe("function");
      expect(typeof engine.shutdown).toBe("function");
      process.env.GITHUB_WEBHOOK_SECRET = original;
    });
  });

  it("throws if GITHUB_WEBHOOK_SECRET is missing (fail closed, never builds an unverifiable server)", async () => {
    const original = process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const { createEngine } = await import("../src/index.js");
    expect(() => createEngine()).toThrow(/GITHUB_WEBHOOK_SECRET/);
    process.env.GITHUB_WEBHOOK_SECRET = original;
  });
});

describe("routing: GET probes are handled before the POST-only gate", () => {
  it("GET /healthz -> 200 ok", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const res = await fetch(`${handle.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET /readyz -> 200 while accepting work", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const res = await fetch(`${handle.baseUrl}/readyz`);
    expect(res.status).toBe(200);
  });

  it("GET /readyz -> 503 once shutdown has been initiated", async () => {
    const { engine, baseUrl } = await startEngine();
    openEngines.push({ engine, baseUrl });

    const before = await fetch(`${baseUrl}/readyz`);
    expect(before.status).toBe(200);

    // Keep one task genuinely in-flight so queue.drain() doesn't resolve instantly — that's
    // what keeps the listener OPEN for the duration of this check (shutdown() drains before it
    // closes the server; see the ordering comment in src/index.ts). Without something in
    // flight, close() would follow the readiness flip almost immediately and there'd be no
    // reliable window left in which to observe the 503 over a real HTTP round trip.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    engine.queue.enqueue("acme/widgets#readyz-probe", async () => { await gate; });

    const shutdownPromise = engine.shutdown();
    await new Promise((r) => setTimeout(r, 10));
    const during = await fetch(`${baseUrl}/readyz`);
    expect(during.status).toBe(503);

    release();
    await shutdownPromise;
  });

  it("GET /metrics -> prom-client exposition text containing afe_ metrics", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const res = await fetch(`${handle.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("afe_webhooks_total");
    expect(body).toContain("afe_queue_running");
    expect(body).toContain("afe_queue_waiting");
    expect(body).toContain("afe_task_duration_seconds");
  });

  it("non-POST, unrecognized GET path -> 405", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const res = await fetch(`${handle.baseUrl}/some-other-path`);
    expect(res.status).toBe(405);
  });

  it("non-POST method on /webhook -> 405", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const res = await fetch(`${handle.baseUrl}/webhook`, { method: "PUT" });
    expect(res.status).toBe(405);
  });

  it("POST to an unknown path -> 404 (unchanged behavior)", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const res = await fetch(`${handle.baseUrl}/nope`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("POST /webhook", () => {
  it("bad signature -> 401", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const body = JSON.stringify({ action: "submitted" });
    const res = await fetch(`${handle.baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=" + "0".repeat(64),
        "X-GitHub-Event": "pull_request_review",
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("missing signature header -> 401", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const res = await fetch(`${handle.baseUrl}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "pull_request_review" },
      body: JSON.stringify({ action: "submitted" }),
    });
    expect(res.status).toBe(401);
  });

  it("ping event -> 200 pong, never enqueued", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const body = JSON.stringify({ zen: "hello" });
    const res = await fetch(`${handle.baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body),
        "X-GitHub-Event": "ping",
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
    const stats = handle.engine.queue.stats();
    expect(stats.running + stats.waiting).toBe(0);
  });

  it("valid pull_request_review 'submitted' -> 202 and enqueues onto the queue keyed by owner/repo#pr", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const payload = {
      action: "submitted",
      review: { state: "approved", commit_id: "deadbeef", user: { login: "bob", type: "User" } },
      pull_request: { number: 7, draft: false, state: "open", head: { sha: "deadbeef" }, user: { login: "alice" } },
      repository: { owner: { login: "acme" }, name: "widgets" },
    };
    const body = JSON.stringify(payload);
    // Total tasks the queue has ever accepted (running + waiting + settled). The mocked octokit
    // resolves near-instantly, so by the time fetch() returns the task may already have
    // completed rather than still be "running" — comparing this sum (not just running+waiting)
    // is what makes the assertion robust to that timing either way.
    const activity = (s: ReturnType<typeof handle.engine.queue.stats>) =>
      s.running + s.waiting + s.completedTotal + s.failedTotal;
    const before = activity(handle.engine.queue.stats());

    const res = await fetch(`${handle.baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body),
        "X-GitHub-Event": "pull_request_review",
        "X-GitHub-Delivery": "test-delivery-1",
      },
      body,
    });

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("Accepted");

    // enqueue() happens synchronously inside the request handler, before the response is
    // flushed to the socket, so by the time fetch() resolves the task has already been
    // accepted into the queue (see src/index.ts's handleRequest / enqueueWebhookEvent).
    expect(activity(handle.engine.queue.stats())).toBeGreaterThan(before);

    await new Promise((r) => setTimeout(r, 20)); // let the (faked) task settle
    expect(fakeOctokit.checks.create).toHaveBeenCalled();
  });

  // PR-lifecycle actions that publish an in_progress check on the PR's head SHA. "opened",
  // "reopened" and "ready_for_review" were added so a brand-new PR shows the engine is present
  // and waiting, instead of no check at all. The security-relevant assertion in each case is the
  // one on the check payload: status "in_progress" and NO `conclusion` field — an in_progress
  // check is non-completed and therefore satisfies nothing, so this path can never be a producer
  // of check success (see PENDING_CHECK_PR_ACTIONS in src/index.ts).
  for (const action of ["opened", "reopened", "ready_for_review"] as const) {
    it(`valid pull_request '${action}' -> 202, enqueues under owner/repo#pr, and sets an in_progress (never passing) check`, async () => {
      const handle = await startEngine();
      openEngines.push(handle);
      const payload = {
        action,
        pull_request: { number: 11, head: { sha: "0badc0de" } },
        repository: { owner: { login: "acme" }, name: "widgets" },
      };
      const body = JSON.stringify(payload);
      const activity = (s: ReturnType<typeof handle.engine.queue.stats>) =>
        s.running + s.waiting + s.completedTotal + s.failedTotal;
      const before = activity(handle.engine.queue.stats());

      const res = await fetch(`${handle.baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": sign(body),
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": `test-delivery-${action}`,
        },
        body,
      });

      expect(res.status).toBe(202);
      expect(activity(handle.engine.queue.stats())).toBeGreaterThan(before);

      await new Promise((r) => setTimeout(r, 20)); // let the (faked) task settle
      expect(fakeOctokit.checks.create).toHaveBeenCalledTimes(1);
      const args = fakeOctokit.checks.create.mock.calls[0][0];
      expect(args).toMatchObject({
        owner: "acme",
        repo: "widgets",
        name: "approval-freshness/evaluated",
        head_sha: "0badc0de",
        status: "in_progress",
      });
      // Non-passing by construction: no conclusion at all, and certainly not a satisfying one.
      expect(args.conclusion).toBeUndefined();
      // Honest UX: on these lifecycle actions nothing is being evaluated yet — the summary must
      // say "waiting for an approval", never the synchronize path's "evaluating" text.
      expect(String(args.output?.summary)).toMatch(/waiting for a human approval/i);
      expect(String(args.output?.summary)).not.toMatch(/evaluating/i);
    });
  }

  it("pull_request 'reopened' on a head SHA that already carries a completed success does NOT clobber it with a pending run", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    // Simulate the approve → close → reopen sequence: the fresh-approval echo (or a PRESERVE
    // verdict) already wrote a completed success for this exact SHA, and both reviews and
    // per-SHA check runs survive a close/reopen. Writing in_progress now would supersede that
    // success and re-block a PR whose approval state never changed.
    fakeOctokit.checks.listForRef.mockResolvedValueOnce({
      data: { check_runs: [{ status: "completed", conclusion: "success" }] },
    });
    const payload = {
      action: "reopened",
      pull_request: { number: 14, head: { sha: "a11ce555" } },
      repository: { owner: { login: "acme" }, name: "widgets" },
    };
    const body = JSON.stringify(payload);

    const res = await fetch(`${handle.baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body),
        "X-GitHub-Event": "pull_request",
      },
      body,
    });

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeOctokit.checks.listForRef).toHaveBeenCalledTimes(1);
    expect(fakeOctokit.checks.listForRef.mock.calls[0][0]).toMatchObject({
      owner: "acme", repo: "widgets", ref: "a11ce555", check_name: "approval-freshness/evaluated",
    });
    // The guard's whole point: the existing success is left intact, no new run is minted.
    expect(fakeOctokit.checks.create).not.toHaveBeenCalled();
  });

  it("pull_request 'synchronize' skips the pre-existing-success read entirely (a fresh push SHA has nothing to clobber)", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const payload = {
      action: "synchronize",
      pull_request: { number: 15, head: { sha: "c0ffee00" } },
      repository: { owner: { login: "acme" }, name: "widgets" },
    };
    const body = JSON.stringify(payload);

    const res = await fetch(`${handle.baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body),
        "X-GitHub-Event": "pull_request",
      },
      body,
    });

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeOctokit.checks.listForRef).not.toHaveBeenCalled();
    expect(fakeOctokit.checks.create).toHaveBeenCalledTimes(1);
    expect(fakeOctokit.checks.create.mock.calls[0][0]).toMatchObject({ status: "in_progress" });
  });

  it("pull_request 'opened' with a missing head SHA is ignored (fail closed, never enqueued)", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const payload = {
      action: "opened",
      pull_request: { number: 12 }, // no head.sha
      repository: { owner: { login: "acme" }, name: "widgets" },
    };
    const body = JSON.stringify(payload);
    const activity = (s: ReturnType<typeof handle.engine.queue.stats>) =>
      s.running + s.waiting + s.completedTotal + s.failedTotal;
    const before = activity(handle.engine.queue.stats());
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await fetch(`${handle.baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body),
        "X-GitHub-Event": "pull_request",
      },
      body,
    });

    expect(res.status).toBe(202); // already ack'd before routing; the drop is silent to GitHub
    await new Promise((r) => setTimeout(r, 20));
    expect(activity(handle.engine.queue.stats())).toBe(before);
    expect(fakeOctokit.checks.create).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("pull_request 'labeled' stays a no-op (not in the pending-check action set)", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const payload = {
      action: "labeled",
      pull_request: { number: 13, head: { sha: "feedface" } },
      repository: { owner: { login: "acme" }, name: "widgets" },
    };
    const body = JSON.stringify(payload);
    const activity = (s: ReturnType<typeof handle.engine.queue.stats>) =>
      s.running + s.waiting + s.completedTotal + s.failedTotal;
    const before = activity(handle.engine.queue.stats());

    const res = await fetch(`${handle.baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body),
        "X-GitHub-Event": "pull_request",
      },
      body,
    });

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(activity(handle.engine.queue.stats())).toBe(before);
    expect(fakeOctokit.checks.create).not.toHaveBeenCalled();
  });

  it("valid pull_request 'synchronize' -> 202 and enqueues under the SAME key shape as the review event", async () => {
    const handle = await startEngine();
    openEngines.push(handle);
    const payload = {
      action: "synchronize",
      pull_request: { number: 9, head: { sha: "cafebabe" } },
      repository: { owner: { login: "acme" }, name: "widgets" },
    };
    const body = JSON.stringify(payload);
    const activity = (s: ReturnType<typeof handle.engine.queue.stats>) =>
      s.running + s.waiting + s.completedTotal + s.failedTotal;
    const before = activity(handle.engine.queue.stats());

    const res = await fetch(`${handle.baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body),
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "test-delivery-2",
      },
      body,
    });

    expect(res.status).toBe(202);
    expect(activity(handle.engine.queue.stats())).toBeGreaterThan(before);
  });
});

describe("graceful shutdown", () => {
  it("shutdown() drains an in-flight task before resolving", async () => {
    const { engine } = await startEngine();
    // Not pushed to openEngines: shutdown() below already closes the server; re-closing an
    // already-closed server in afterEach is handled defensively there regardless.
    openEngines.push({ engine, baseUrl: "" } as EngineHandle);

    let taskFinished = false;
    let resolveTask!: () => void;
    const taskGate = new Promise<void>((r) => { resolveTask = r; });
    engine.queue.enqueue("acme/widgets#1", async () => {
      await taskGate;
      taskFinished = true;
    });

    const shutdownPromise = engine.shutdown();
    await new Promise((r) => setTimeout(r, 10));
    expect(taskFinished).toBe(false); // shutdown is waiting on the drain

    resolveTask();
    await shutdownPromise;
    expect(taskFinished).toBe(true);
  });

  it("shutdown() is idempotent under repeated calls (SIGTERM racing SIGINT)", async () => {
    const { engine } = await startEngine();
    openEngines.push({ engine, baseUrl: "" } as EngineHandle);
    await Promise.all([engine.shutdown(), engine.shutdown(), engine.shutdown()]);
  });
});
