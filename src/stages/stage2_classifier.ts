import { Decision, Delta, dismiss, preserve } from "./types.js";
import { EngineConfig } from "../config/schema.js";
import { classifyImpact, ModelVerdict } from "../model/provider.js";

/**
 * Executes Stage 2: AI impact classifier with deterministic corroboration gates.
 * Fail-Closed Invariant: The AI model's output is advisory and heavily gated. Any failure, error,
 * timeout, high-impact assessment, or failure of a deterministic corroboration gate results in a DISMISS.
 * A PRESERVE is only issued when both the AI and all strict deterministic checks agree.
 *
 * @param delta - The change context.
 * @param cfg - The runtime engine configuration.
 * @returns A PRESERVE Decision if all gates and the model pass, otherwise a DISMISS Decision.
 */
export async function stage2(delta: Delta, cfg: EngineConfig): Promise<Decision> {
  try {
    let verdict: ModelVerdict;
    try {
      verdict = await classifyImpact(delta, cfg); // structured JSON, no tools, no loop
    } catch (e: any) {
      // Fail closed on ANY model problem (timeout, malformed JSON, provider outage).
      return dismiss(2, "model_error", `Model classification failed: ${e?.message ?? "unknown"}; failing closed.`);
    }

    // ---- Deterministic corroboration gates (override the model) ----
    const gates: Record<string, boolean> = {};

    gates.impactLow = verdict.impact === "low";
    gates.confidence = verdict.confidence >= cfg.thresholds.confThreshold;
    gates.sizeLines = (delta.addedLines + delta.removedLines) <= cfg.thresholds.softMaxLines;
    gates.sizeFiles = delta.changedFiles.length <= cfg.thresholds.softMaxFiles;

    gates.noSensitivePatterns = true;
    gates.noNewDependencies = true;
    gates.safeRegexSize = true;

    // You cannot classify what you cannot see. GitHub OMITS the `patch` field for binary files
    // and for very large diffs, so `patchByFile[file]` can legitimately be empty while the file's
    // content changed substantially. With an empty patch the model is shown nothing, the
    // sensitive-pattern scan matches nothing, and the new-dependency scan finds nothing — every
    // content gate passes vacuously and a completely unseen change could be preserved.
    // Requiring a visible patch for every changed file closes that: an invisible delta can never
    // be corroborated, so it goes to a human. Conservative for a pure rename (no patch, no
    // content change), which is rare and costs one re-review.
    gates.patchVisible = delta.changedFiles.length > 0 &&
      delta.changedFiles.every((f) => (delta.patchByFile[f] ?? "").trim().length > 0);

    // The same principle one level up: if the diff was longer than the model's input budget it
    // was CUT before the model saw it, so the verdict describes only the visible prefix. A
    // payload placed past the cut point would never reach the classifier at all. A partial view
    // can never corroborate a preserve.
    gates.fullDiffSeen = !verdict.truncated;

    for (const patch of Object.values(delta.patchByFile)) {
      if (patch.length > 500_000) {
        gates.safeRegexSize = false;
        continue;
      }
      if (cfg.sensitivePatterns.some((rx) => rx.test(patch))) {
        gates.noSensitivePatterns = false;
      }
      if (looksLikeNewDependency(patch)) {
        gates.noNewDependencies = false;
      }
    }

    const allPass = Object.values(gates).every(Boolean);
    const evidence = { verdict, gates };

    if (verdict.impact === "high") {
      return dismiss(2, "model_high_impact",
        `Classifier assessed high impact: ${(verdict.reasons || []).join("; ")}.`, evidence);
    }
    if (!gates.confidence) {
      return dismiss(2, "model_low_confidence",
        `Classifier confidence ${verdict.confidence} < ${cfg.thresholds.confThreshold}; failing closed.`, evidence);
    }
    if (!allPass) {
      const failed = Object.entries(gates).filter(([, v]) => !v).map(([k]) => k);
      return dismiss(2, "corroboration_gate_failed",
        `Model said low but deterministic gates failed: ${failed.join(", ")}.`, evidence);
    }

    // model low + ALL gates pass → the only PRESERVE the AI can contribute to.
    return preserve(2, "model_low_impact_gated",
      `Low-impact delta corroborated by all deterministic gates. ${(verdict.reasons || []).join("; ")}.`, evidence);
  } catch (err: any) {
    return dismiss(2, "stage2_unexpected_error", `Unexpected error in stage 2 classification: ${err?.message ?? "unknown"}`);
  }
}

/**
 * Scans a patch string for heuristic indicators of new dependencies.
 * Fail-Closed Invariant: This is a belt-and-suspenders heuristic check. If a new dependency
 * is suspected, it returns true, causing a corroboration gate failure and triggering a DISMISS.
 *
 * @param patch - The unified patch text.
 * @returns true if a new dependency might be introduced, false otherwise.
 */
function looksLikeNewDependency(patch: string): boolean {
  // Only ADDED lines matter: a removed import is not a new dependency.
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  if (added.length === 0) return false;

  for (const raw of added) {
    const line = raw.slice(1);

    // Dependency-manifest entry, e.g.  "lodash": "^4.17.21"
    if (/^\s*["']?[\w@/.-]+["']?\s*:\s*["']\^?~?[\d*]/.test(line)) return true;

    // Module loading in the forms real code actually uses. The previous version anchored on the
    // line STARTING with import/require, which missed the single most common JavaScript form —
    // `const helper = require("./helper")` — and therefore let a dependency addition through the
    // gate entirely. Found live: a PR adding exactly that line was PRESERVED. Match the call and
    // the statement wherever they appear on the line instead of only at its start.
    if (/\brequire\s*\(/.test(line)) return true;                       // require("x"), = require('x')
    if (/\bimport\s*\(/.test(line)) return true;                        // dynamic import("x")
    if (/^\s*import\b/.test(line)) return true;                         // ES/Java/Python import
    if (/^\s*from\s+[\w.]+\s+import\b/.test(line)) return true;         // python: from x import y
    if (/^\s*use\s+[\w:]+/.test(line)) return true;                     // rust: use a::b;
    if (/^\s*#\s*include\b/.test(line)) return true;                    // c/c++
    if (/^\s*(go\s+)?get\s+[\w.\-/]+\/[\w.\-/]+/.test(line)) return true; // go get github.com/x/y

    // A bare quoted module path on its own line — Go import blocks, and lockfile-ish additions.
    if (/^\s*(_\s+|\w+\s+)?"[\w.\-]+\.[\w.\-]+\/[\w.\-/]+"\s*$/.test(line)) return true;
  }
  return false;
}
