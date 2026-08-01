import { EngineConfig } from "../src/config/schema.js";

export function testConfig(): EngineConfig {
  return {
    difftasticBin: "difft",
    selfGovernedRepos: ["test-org/approval-freshness-engine"],
    // Existing tests were written against a ladder that always reached Stage 2, so the default
    // here keeps that behavior; the deterministic-only path has its own dedicated cases.
    stage2Enabled: true,
    denylist: { paths: ["**/*.tf", "**/prod/**", ".github/workflows/**", "**/package.json"] },
    codeownersGlobs: [],
    trivialClasses: {
      docs: ["**/*.md"],
      lockfiles: { files: ["**/package-lock.json"], requireBotAuthor: ["dependabot[bot]", "renovate[bot]"] },
      generated: { files: ["**/*.pb.go"], requireDeterministicRegen: true },
    },
    injectionCanaries: [/impact:\s*low/i, /ignore previous/i, /classifier:/i, /mark this/i],
    sensitivePatterns: [/\b(password|jwt|hmac|authenticate|authorize)\b/i, /\b(eval|exec|deserialize)\b/i, /\bfetch\(|axios|http\./i],
    thresholds: { confThreshold: 0.85, softMaxLines: 40, softMaxFiles: 5, hardMaxLines: 400, hardMaxFiles: 20, modelTimeoutMs: 8000, stalePendingMs: 900000 },
    model: { invoke: async () => JSON.stringify({ impact: "high", confidence: 0.9, reasons: ["stub"] }), maxInputChars: 20000 },
  };
}
