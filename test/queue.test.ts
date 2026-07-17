import { describe, it, expect, vi } from "vitest";
import { WorkQueue } from "../src/runtime/queue.js";

// --- test helpers -------------------------------------------------------------------------
function defer<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("WorkQueue: coalescing", () => {
  it("a same-key task still WAITING is replaced outright; the replaced task never runs", async () => {
    const q = new WorkQueue({ concurrency: 1 });
    const gate = defer<void>();
    const order: string[] = [];

    // "A" starts running immediately (concurrency=1) and blocks on `gate`.
    q.enqueue("pr", async () => { order.push("A"); await gate.promise; });
    // "B" becomes the waiting task for key "pr".
    const bRan = vi.fn();
    expect(q.enqueue("pr", async () => { bRan(); order.push("B"); })).toBe(true);
    // "C" arrives while "B" is still waiting (A hasn't finished) -> coalesces, replacing B.
    expect(q.enqueue("pr", async () => { order.push("C"); })).toBe(true);

    expect(q.stats().coalescedTotal).toBe(1);
    expect(q.stats().waiting).toBe(1); // one slot, now holding C

    gate.resolve();
    await waitFor(() => q.stats().completedTotal === 2);

    expect(bRan).not.toHaveBeenCalled();
    expect(order).toEqual(["A", "C"]);
  });

  it("invokes hooks.onCoalesced exactly once per replaced waiting task", async () => {
    const q = new WorkQueue({ concurrency: 1 });
    const onCoalesced = vi.fn();
    const q2 = new WorkQueue({ concurrency: 1, hooks: { onCoalesced } });
    const gate = defer<void>();
    q2.enqueue("pr", async () => { await gate.promise; });
    q2.enqueue("pr", async () => {});
    q2.enqueue("pr", async () => {});
    q2.enqueue("pr", async () => {});
    expect(onCoalesced).toHaveBeenCalledTimes(2); // 2nd and 3rd waiting entries each replaced once
    gate.resolve();
    await waitFor(() => q2.stats().completedTotal === 2);
    void q; // unused sibling instance guard (keeps this test self-contained)
  });
});

describe("WorkQueue: per-key serialization", () => {
  it("never runs two tasks for the same key concurrently, even across several enqueues", async () => {
    const q = new WorkQueue({ concurrency: 8 });
    let inFlight = 0;
    let overlapped = false;

    const makeTask = () => async () => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
    };

    q.enqueue("same-key", makeTask());
    q.enqueue("same-key", makeTask()); // waits behind the first
    q.enqueue("same-key", makeTask()); // coalesces with the second

    await waitFor(() => q.stats().completedTotal === 2);
    expect(overlapped).toBe(false);
  });

  it("runs DIFFERENT keys concurrently (serialization is per-key, not global)", async () => {
    const q = new WorkQueue({ concurrency: 8 });
    let inFlight = 0;
    let sawConcurrency = false;
    const gates = [defer<void>(), defer<void>()];

    q.enqueue("key-a", async () => { inFlight++; if (inFlight > 1) sawConcurrency = true; await gates[0].promise; inFlight--; });
    q.enqueue("key-b", async () => { inFlight++; if (inFlight > 1) sawConcurrency = true; await gates[1].promise; inFlight--; });

    await waitFor(() => q.stats().running === 2);
    expect(sawConcurrency).toBe(true);
    gates[0].resolve();
    gates[1].resolve();
    await waitFor(() => q.stats().completedTotal === 2);
  });
});

describe("WorkQueue: global concurrency bound", () => {
  it("never runs more than N tasks concurrently across N+2 distinct keys", async () => {
    const N = 3;
    const total = N + 2;
    const q = new WorkQueue({ concurrency: N, maxPending: 100 });
    let active = 0;
    let maxActive = 0;
    const gates: Array<() => void> = [];

    for (let i = 0; i < total; i++) {
      q.enqueue(`k${i}`, () => new Promise<void>((resolve) => {
        active++;
        maxActive = Math.max(maxActive, active);
        gates.push(() => { active--; resolve(); });
      }));
    }

    // Exactly N should have started immediately; the rest wait.
    expect(q.stats().running).toBe(N);
    expect(q.stats().waiting).toBe(total - N);

    while (q.stats().completedTotal < total) {
      const toRelease = gates.splice(0, gates.length);
      toRelease.forEach((release) => release());
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(maxActive).toBe(N);
    expect(q.stats().completedTotal).toBe(total);
  });
});

describe("WorkQueue: bounded size / overflow rejection", () => {
  it("rejects enqueue once distinct waiting keys reach maxPending; never crashes", async () => {
    const q = new WorkQueue({ concurrency: 1, maxPending: 2 });
    const onRejected = vi.fn();
    const q2 = new WorkQueue({ concurrency: 1, maxPending: 2, hooks: { onRejected } });
    const gate = defer<void>();

    expect(q2.enqueue("k0", () => gate.promise)).toBe(true); // starts running, occupies no waiting slot
    expect(q2.enqueue("k1", async () => {})).toBe(true); // waiting slot 1/2
    expect(q2.enqueue("k2", async () => {})).toBe(true); // waiting slot 2/2
    expect(q2.enqueue("k3", async () => {})).toBe(false); // overflow: 3rd distinct waiting key

    expect(q2.stats().rejectedTotal).toBe(1);
    expect(q2.stats().waiting).toBe(2);
    expect(onRejected).toHaveBeenCalledWith("k3");

    gate.resolve();
    await waitFor(() => q2.stats().completedTotal === 3);
    void q; // unused sibling instance guard
  });
});

describe("WorkQueue: drain", () => {
  it("resolves once in-flight work completes and refuses newly-enqueued tasks meanwhile", async () => {
    const q = new WorkQueue({ concurrency: 2 });
    const gate = defer<void>();
    let ran = false;
    q.enqueue("k1", async () => { await gate.promise; ran = true; });

    let drained = false;
    const drainPromise = q.drain(5000).then(() => { drained = true; });

    // Stop starting new tasks: an enqueue during drain is refused outright.
    expect(q.enqueue("k2", async () => {})).toBe(false);

    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false); // still waiting on the in-flight k1 task

    gate.resolve();
    await drainPromise;
    expect(drained).toBe(true);
    expect(ran).toBe(true);
  });

  it("resolves at the timeout if in-flight work does not finish in time (never hangs)", async () => {
    const q = new WorkQueue({ concurrency: 1 });
    const gate = defer<void>();
    q.enqueue("k1", () => gate.promise);

    const start = Date.now();
    await q.drain(30);
    expect(Date.now() - start).toBeLessThan(1000);

    gate.resolve(); // let the still-running task finish so it doesn't dangle past the test
  });
});

describe("WorkQueue: error containment", () => {
  it("a throwing task is caught and counted; the queue keeps serving other keys", async () => {
    const q = new WorkQueue({ concurrency: 2 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let secondRan = false;

    q.enqueue("bad", async () => { throw new Error("boom"); });
    q.enqueue("good", async () => { secondRan = true; });

    await waitFor(() => q.stats().completedTotal + q.stats().failedTotal === 2);

    expect(q.stats().failedTotal).toBe(1);
    expect(q.stats().completedTotal).toBe(1);
    expect(secondRan).toBe(true);
    errSpy.mockRestore();
  });

  it("hooks.onSettled reports ok=false with a duration for a failed task", async () => {
    const onSettled = vi.fn();
    const q = new WorkQueue({ concurrency: 1, hooks: { onSettled } });
    vi.spyOn(console, "error").mockImplementation(() => {});

    q.enqueue("bad", async () => { throw new Error("boom"); }, { kind: "synchronize" });
    await waitFor(() => q.stats().failedTotal === 1);

    expect(onSettled).toHaveBeenCalledTimes(1);
    const [key, meta, durationMs, ok] = onSettled.mock.calls[0];
    expect(key).toBe("bad");
    expect(meta).toEqual({ kind: "synchronize" });
    expect(typeof durationMs).toBe("number");
    expect(ok).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("WorkQueue: stats()", () => {
  it("reports the full shape with zeroed counters on a fresh queue", () => {
    const q = new WorkQueue();
    expect(q.stats()).toEqual({
      running: 0, waiting: 0, coalescedTotal: 0, completedTotal: 0, rejectedTotal: 0, failedTotal: 0,
    });
  });
});
