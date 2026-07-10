import { Decision, Delta, dismiss, preserve } from "./types.js";
import { EngineConfig } from "../config/schema.js";
import { classifyImpact, ModelVerdict } from "../model/provider.js";

// Stage 2: AI impact classifier — ADVISORY ONLY. The model's output is DATA.
// A PRESERVE requires model-low AND every deterministic corroboration gate to pass.
// Any failure, error, timeout, or high-impact → DISMISS. The AI can never approve;
// its most permissive possible effect is to *not dismiss* an already-human-approved,
// denylist-cleared, size-capped, pattern-clean change.
export async function stage2(delta: Delta, cfg: EngineConfig): Promise<Decision> {
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

  const patchText = Object.values(delta.patchByFile).join("\n");
  gates.noSensitivePatterns = !cfg.sensitivePatterns.some((rx) => rx.test(patchText));
  gates.noNewDependencies = !looksLikeNewDependency(patchText);

  const allPass = Object.values(gates).every(Boolean);
  const evidence = { verdict, gates };

  if (verdict.impact === "high") {
    return dismiss(2, "model_high_impact",
      `Classifier assessed high impact: ${verdict.reasons.join("; ")}.`, evidence);
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
    `Low-impact delta corroborated by all deterministic gates. ${verdict.reasons.join("; ")}.`, evidence);
}

function looksLikeNewDependency(patch: string): boolean {
  // Cheap heuristic; dependency manifests are denylisted in Stage 0 anyway, this is belt-and-suspenders.
  return /^\+\s*["']?[\w@/.-]+["']?\s*:\s*["']\^?~?\d/m.test(patch) // json manifest add
      || /^\+\s*(import|require|use)\s+/m.test(patch);              // new import line
}
