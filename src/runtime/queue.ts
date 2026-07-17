// A keyed, coalescing, bounded work queue — the scale core for handling many parallel PRs.
// Pure TypeScript, stdlib only (process.env, setTimeout, console). Deliberately dependency-free
// so it stays trivially unit-testable and so src/observability/metrics.ts (not this file) is the
// only place that knows about prom-client — see the `hooks` param below.
//
// Why these semantics, in one place:
//  - COALESCING: required checks are matched per head SHA. If a PR gets pushed twice before the
//    first push's task even starts, evaluating the first (now-superseded) SHA is pure waste —
//    only the latest push's outcome can ever matter. So a same-key task still WAITING (not yet
//    started) is replaced outright by a newer one; the replaced task never runs.
//  - PER-KEY SERIALIZATION: the evaluation write (setCheckPending / dismiss+setCheck) and the
//    fresh-approval echo write (setCheckSuccessForFreshApproval) both touch the same PR's check
//    run. Running two tasks for the same key concurrently would race those writes. So a key
//    never has more than one task in flight; a new arrival for a running key waits (and itself
//    coalesces with any other waiting task for that key).
//  - BOUNDED SIZE + OVERFLOW REJECTION: the webhook handler already returned 202 before enqueue
//    is ever called, so a rejected enqueue is safe by construction — the PR's check simply stays
//    missing, which is a fail-CLOSED state (missing check blocks merge; reconciliation on the
//    next webhook or a fresh, current-head approval recovers it). This queue must therefore
//    NEVER throw or crash the process on overflow; it just says no and counts it.

/** A unit of work. Errors are caught by the queue — a throwing task never kills the process. */
export type Task = () => Promise<void>;

/**
 * Optional, free-form metadata carried alongside a task and handed back to hooks (e.g. the
 * task "kind" for the duration histogram's label, or a delivery id for logging). The queue
 * never inspects this itself — it only stores and forwards it — which is what keeps this file
 * free of any opinion about what metrics or logging look like.
 */
export type TaskMeta = Record<string, unknown> | undefined;

/**
 * Injected callbacks so a consumer (src/observability/metrics.ts, via src/index.ts) can wire
 * real counters/histograms without this file importing prom-client or anything else. All hooks
 * are optional and best-effort: a throwing hook is not caught specially (keep them cheap and
 * synchronous), but a missing hook is always a safe no-op.
 */
export interface QueueHooks {
  /** A waiting (not-yet-started) task for `key` was replaced by a newer one and will never run. */
  onCoalesced?: (key: string) => void;
  /** An enqueue call was refused (queue full, or a drain is in progress). */
  onRejected?: (key: string) => void;
  /** A task for `key` finished (successfully or not); durationMs covers only the task's own run. */
  onSettled?: (key: string, meta: TaskMeta, durationMs: number, ok: boolean) => void;
}

export interface QueueStats {
  running: number;
  waiting: number;
  coalescedTotal: number;
  completedTotal: number;
  rejectedTotal: number;
  failedTotal: number;
}

export interface QueueOptions {
  /** Max concurrently RUNNING tasks. Default: AFE_WORKER_CONCURRENCY env, else 16. */
  concurrency?: number;
  /** Max distinct WAITING (not-yet-started) keys. Default: AFE_QUEUE_MAX_PENDING env, else 1000. */
  maxPending?: number;
  hooks?: QueueHooks;
}

interface WaitingEntry {
  task: Task;
  meta: TaskMeta;
}

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_MAX_PENDING = 1000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class WorkQueue {
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly hooks: QueueHooks;

  // Invariant: a key appears in `waitingTasks` iff it has a task that has NOT yet started. Once
  // a key starts running it is removed from here (and from `queueOrder`) and added to
  // `runningKeys`; a subsequent enqueue() for that key then creates a fresh waiting entry.
  private readonly waitingTasks = new Map<string, WaitingEntry>();
  // FIFO order in which distinct waiting keys became eligible to run. May contain a key whose
  // entry has since been coalesced away (waitingTasks still has it, just with new content) or a
  // key that is currently running-again-pending (present here, absent from waitingTasks until a
  // later enqueue re-adds it) — pump() below filters on both maps, so stale order entries are
  // harmless and just get skipped.
  private readonly queueOrder: string[] = [];
  private readonly runningKeys = new Set<string>();

  private draining = false;
  private drainWaiters: Array<() => void> = [];

  private coalescedTotal = 0;
  private completedTotal = 0;
  private rejectedTotal = 0;
  private failedTotal = 0;

  constructor(opts: QueueOptions = {}) {
    this.concurrency = opts.concurrency ?? envInt("AFE_WORKER_CONCURRENCY", DEFAULT_CONCURRENCY);
    this.maxPending = opts.maxPending ?? envInt("AFE_QUEUE_MAX_PENDING", DEFAULT_MAX_PENDING);
    this.hooks = opts.hooks ?? {};
  }

  /**
   * Enqueues `task` under `key`. Returns true if accepted (which may mean it started running
   * immediately, is waiting behind an in-flight task for the same key, or coalesced into an
   * already-waiting slot), false if refused (queue full, or draining).
   *
   * @param key - `${owner}/${repo}#${prNumber}` in this engine's usage; serialization and
   *   coalescing both operate per-key.
   * @param task - The work to run. Its errors are caught by the queue (see run()).
   * @param meta - Opaque metadata forwarded to hooks.onSettled (e.g. { kind: "synchronize" }).
   */
  enqueue(key: string, task: Task, meta?: TaskMeta): boolean {
    if (this.draining) {
      // Fail-closed refusal, same posture as overflow below: draining means "no new work will
      // ever start", so accepting it would just be a silent no-op with no way for the caller to
      // know — refuse explicitly instead so callers can log it.
      this.rejectedTotal++;
      this.hooks.onRejected?.(key);
      return false;
    }

    const existing = this.waitingTasks.get(key);
    if (existing) {
      // Coalescing: a same-key task is already waiting to start. The new webhook supersedes it
      // outright — the replaced task is dropped and never runs.
      this.waitingTasks.set(key, { task, meta });
      this.coalescedTotal++;
      this.hooks.onCoalesced?.(key);
      return true;
    }

    if (this.waitingTasks.size >= this.maxPending) {
      this.rejectedTotal++;
      this.hooks.onRejected?.(key);
      return false;
    }

    this.waitingTasks.set(key, { task, meta });
    this.queueOrder.push(key);
    this.pump();
    return true;
  }

  /** Starts as many waiting, not-currently-running keys as the concurrency bound allows. */
  private pump(): void {
    if (this.draining) return;
    while (this.runningKeys.size < this.concurrency) {
      const idx = this.queueOrder.findIndex((k) => this.waitingTasks.has(k) && !this.runningKeys.has(k));
      if (idx === -1) break;
      const key = this.queueOrder[idx];
      this.queueOrder.splice(idx, 1);
      const entry = this.waitingTasks.get(key)!;
      this.waitingTasks.delete(key);
      this.runningKeys.add(key);
      void this.run(key, entry);
    }
  }

  private async run(key: string, entry: WaitingEntry): Promise<void> {
    const startedAt = Date.now();
    let ok = true;
    try {
      await entry.task();
    } catch (err) {
      ok = false;
      this.failedTotal++;
      // Errors are caught, counted, and logged HERE so one misbehaving task can never kill the
      // process or block any other key — per-key serialization only isolates concurrency, not
      // error propagation.
      console.error(`[queue] task for key "${key}" failed:`, err);
    } finally {
      if (ok) this.completedTotal++;
      const durationMs = Date.now() - startedAt;
      // Queue accounting is finalized BEFORE any injected hook runs: if a hook ever threw with
      // the old ordering (hook first), the slot release + pump below would be skipped, leaking
      // a concurrency slot permanently — repeated occurrences would stall the whole queue. With
      // this ordering a throwing hook can at worst lose one metrics sample.
      this.runningKeys.delete(key);
      if (this.draining && this.runningKeys.size === 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        waiters.forEach((w) => w());
      }
      this.pump();
      try {
        this.hooks.onSettled?.(key, entry.meta, durationMs, ok);
      } catch (hookErr) {
        // Best-effort observability must never affect queue correctness (or become an
        // unhandledRejection through the floating run() promise).
        console.error(`[queue] onSettled hook for key "${key}" threw:`, hookErr);
      }
    }
  }

  /**
   * Stops starting new tasks and resolves once all currently-running tasks complete, or after
   * `timeoutMs`, whichever comes first. Tasks still WAITING when the timeout hits are simply
   * abandoned (never started) — safe by construction, see the file header. Idempotent: safe to
   * call more than once (e.g. SIGTERM racing SIGINT); all callers' promises resolve together
   * once drain conditions are met.
   */
  drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    if (this.runningKeys.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.drainWaiters.push(finish);
    });
  }

  stats(): QueueStats {
    return {
      running: this.runningKeys.size,
      waiting: this.waitingTasks.size,
      coalescedTotal: this.coalescedTotal,
      completedTotal: this.completedTotal,
      rejectedTotal: this.rejectedTotal,
      failedTotal: this.failedTotal,
    };
  }
}
