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

export async function loadConfig(): Promise<EngineConfig> {
  // Real impl: read denylist.yaml + defaults, wire the model provider (Bedrock/Anthropic).
  // Kept as a typed stub so the tree compiles and tests inject testConfig().
  throw new Error("loadConfig: wire to config/denylist.yaml + model provider at deploy time");
}
