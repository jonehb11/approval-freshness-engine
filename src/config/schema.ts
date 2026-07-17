import { z } from "zod";

// Runtime config. Denylist/thresholds come from version-controlled YAML/ConfigMap (Git),
// which is the control surface security co-owns.
export interface EngineConfig {
  difftasticBin: string;
  // Repos whose control surface this engine must NOT self-grade. REQUIRED (not optional) so
  // every deployment consciously declares its own identity — typically
  // ["<org>/approval-freshness-engine"] plus any fork/ops repos that host engine control
  // surface. When delta.repo is in this list and a changed file matches a
  // SELF_GOVERNANCE_GLOB (a hardcoded constant in stage0, deliberately NOT here so mutable
  // config can never loosen it), Stage 0 dismisses with reason "self_governance": the engine
  // never preserves an approval on a PR that alters its own gates, prompt, echo, workflows,
  // or ruleset. Such PRs always get fresh human review (CODEOWNERS security review).
  // When loadConfig is wired, validate this with zod as a non-empty array of "owner/name"
  // strings so a missing/misconfigured value surfaces as an explicit startup error rather
  // than a per-PR runtime throw (which the ladder would still convert to a fail-closed
  // dismiss, but with an opaque model_error reason).
  selfGovernedRepos: string[];
  denylist: { paths: string[] };
  codeownersGlobs?: string[];
  trivialClasses: {
    docs: string[];
    lockfiles: { files: string[]; requireBotAuthor: string[] };
    generated: { files: string[]; requireDeterministicRegen: boolean };
  };
  injectionCanaries: RegExp[];
  sensitivePatterns: RegExp[];
  thresholds: {
    confThreshold: number; softMaxLines: number; softMaxFiles: number;
    hardMaxLines: number; hardMaxFiles: number; modelTimeoutMs: number; stalePendingMs: number;
  };
  model: {
    invoke: (args: { system: string; user: string; maxTokens: number; timeoutMs: number }) => Promise<string>;
    maxInputChars: number;
  };
}

/**
 * Loads the runtime configuration.
 * Fail-Closed Invariant: If the configuration cannot be loaded, parsed, or defaults cannot be satisfied,
 * this function must throw an error. This exception will be caught by the orchestrator (ladder.ts)
 * to guarantee a fail-closed (DISMISS) outcome.
 *
 * @returns A promise that resolves to the EngineConfig.
 */
export async function loadConfig(): Promise<EngineConfig> {
  // Real impl: read denylist.yaml + defaults, wire the model provider (Bedrock/Anthropic).
  // Kept as a typed stub so the tree compiles and tests inject testConfig().
  throw new Error("loadConfig: wire to config/denylist.yaml + model provider at deploy time");
}
