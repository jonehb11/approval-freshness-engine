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
  // Cheap heuristic; dependency manifests are denylisted in Stage 0 anyway, this is belt-and-suspenders.
  return /^\+\s*["']?[\w@/.-]+["']?\s*:\s*["']\^?~?\d/m.test(patch) // json manifest add
      || /^\+\s*(import|require|use)\s+/m.test(patch);              // new import line
}
