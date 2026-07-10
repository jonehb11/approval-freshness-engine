import { Decision, Delta, dismiss } from "./types.js";
import { EngineConfig } from "../config/schema.js";
import { stage0 } from "./stage0_hardrules.js";
import { stage1 } from "./stage1_difftastic.js";
import { stage2 } from "./stage2_classifier.js";

// Orchestrates the fail-closed ladder. Any thrown error anywhere → DISMISS (fail closed).
export async function evaluate(delta: Delta, cfg: EngineConfig): Promise<Decision> {
  try {
    if (!delta.approvedSha) {
      return dismiss(0, "unresolved_approved_sha",
        "Could not resolve the commit the approval was submitted against; failing closed.");
    }

    // Stage 0 — deterministic hard rules. Short-circuits to DISMISS.
    const s0 = stage0(delta, cfg);
    if (s0) return s0;

    // Stage 1 — deterministic semantic diff. Short-circuits to PRESERVE.
    const s1 = await stage1(delta, cfg);
    if (s1) return s1;

    // Stage 2 — advisory model + corroboration gates. Always terminal.
    return await stage2(delta, cfg);
  } catch (e: any) {
    // The master fail-closed guarantee: nothing reaches here without dismissing.
    return dismiss(0, "model_error", `Unexpected engine error: ${e?.message ?? e}; failing closed.`);
  }
}
