import { z } from "zod";

// Runtime config. Denylist/thresholds come from version-controlled YAML/ConfigMap (Git),
// which is the control surface security co-owns.
export interface EngineConfig {
  difftasticBin: string;
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
