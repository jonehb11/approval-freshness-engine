import { readFileSync } from "node:fs";
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import type { QueueHooks, QueueStats, TaskMeta } from "../runtime/queue.js";

/**
 * Resolves the running build's version once at startup so it can be exposed as an
 * afe_build_info gauge — the standard way to correlate a pod's observed behavior with the
 * exact build that's deployed. package.json sits two levels up from this file in the source
 * tree (src/observability/ → repo root) but three levels up in the compiled container layout
 * (dist/src/observability/ → /app), so both candidates are tried; failure degrades to
 * "unknown" rather than ever affecting startup.
 */
function resolveVersion(): string {
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
      if (typeof pkg?.version === "string" && pkg.version) return pkg.version;
    } catch { /* try next candidate */ }
  }
  return "unknown";
}

/**
 * Prometheus metrics for the engine. A FRESH Registry is created per createMetrics() call
 * rather than reusing prom-client's process-wide default registry, so createEngine() (src/index.ts)
 * can be invoked more than once in the same process — notably by tests — without "metric already
 * registered" collisions across instances.
 */
export interface Metrics {
  register: Registry;
  webhooksTotal: Counter<"event" | "outcome">;
  queueRunning: Gauge<string>;
  queueWaiting: Gauge<string>;
  queueCoalescedTotal: Counter<string>;
  queueRejectedTotal: Counter<string>;
  taskFailuresTotal: Counter<string>;
  taskDurationSeconds: Histogram<"kind">;
}

export function createMetrics(): Metrics {
  const register = new Registry();
  collectDefaultMetrics({ register });

  // Constant-value build-info gauge (the conventional `*_build_info` pattern): always 1, with
  // the interesting data in the labels. Both label values are fixed for the process lifetime,
  // so cardinality is exactly 1 series per running pod. AFE_BUILD_COMMIT is stamped by the
  // deployment (Helm passes image.tag; see deploy/helm/templates/deployment.yaml).
  new Gauge({
    name: "afe_build_info",
    help: "Build/version identity of the running engine (value is always 1; see labels).",
    labelNames: ["version", "commit"] as const,
    registers: [register],
  }).labels(resolveVersion(), process.env.AFE_BUILD_COMMIT || "unknown").set(1);

  const webhooksTotal = new Counter({
    name: "afe_webhooks_total",
    help: "Webhook deliveries received, by (normalized) event type and outcome.",
    labelNames: ["event", "outcome"] as const,
    registers: [register],
  });

  const queueRunning = new Gauge({
    name: "afe_queue_running",
    help: "Tasks currently executing in the work queue (point-in-time sample).",
    registers: [register],
  });

  const queueWaiting = new Gauge({
    name: "afe_queue_waiting",
    help: "Distinct keys waiting to start in the work queue (point-in-time sample).",
    registers: [register],
  });

  const queueCoalescedTotal = new Counter({
    name: "afe_queue_coalesced_total",
    help: "Waiting tasks replaced by a newer task for the same key; the replaced task never ran.",
    registers: [register],
  });

  const queueRejectedTotal = new Counter({
    name: "afe_queue_rejected_total",
    help: "Enqueue calls refused (queue at AFE_QUEUE_MAX_PENDING, or draining).",
    registers: [register],
  });

  const taskFailuresTotal = new Counter({
    name: "afe_task_failures_total",
    help: "Queued tasks that threw. Never crashes the process; counted here for alerting.",
    registers: [register],
  });

  const taskDurationSeconds = new Histogram({
    name: "afe_task_duration_seconds",
    help: "Queued task execution duration in seconds, by kind.",
    labelNames: ["kind"] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [register],
  });

  return {
    register, webhooksTotal, queueRunning, queueWaiting,
    queueCoalescedTotal, queueRejectedTotal, taskFailuresTotal, taskDurationSeconds,
  };
}

/**
 * Builds the WorkQueue's `hooks` option from a Metrics instance. This is the ONLY place that
 * connects the two: src/runtime/queue.ts declares the QueueHooks shape but never imports
 * prom-client (or this module), which is what keeps it dependency-free and independently
 * unit-testable (see queue.ts's file header).
 */
export function queueMetricsHooks(metrics: Metrics): QueueHooks {
  return {
    onCoalesced: () => metrics.queueCoalescedTotal.inc(),
    onRejected: () => metrics.queueRejectedTotal.inc(),
    onSettled: (_key: string, meta: TaskMeta, durationMs: number, ok: boolean) => {
      const kind = typeof meta?.kind === "string" ? meta.kind : "unknown";
      metrics.taskDurationSeconds.labels(kind).observe(durationMs / 1000);
      if (!ok) metrics.taskFailuresTotal.inc();
    },
  };
}

/**
 * Samples the queue's live running/waiting counts into the gauges. These are point-in-time
 * snapshots (not cumulative counters), so call this right before serving each /metrics scrape
 * rather than trying to keep it continuously in sync — see GET /metrics in src/index.ts.
 */
export function sampleQueueGauges(metrics: Metrics, stats: Pick<QueueStats, "running" | "waiting">): void {
  metrics.queueRunning.set(stats.running);
  metrics.queueWaiting.set(stats.waiting);
}
