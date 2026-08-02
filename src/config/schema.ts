import { z } from "zod";
import { readFileSync } from "node:fs";

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
  selfGovernedRepos: string[];
  /**
   * When false, the ladder never calls the model: anything Stages 0-1 cannot decide
   * deterministically dismisses with reason "deterministic_only_mode". REQUIRED (no default) so
   * that running the advisory classifier is always a conscious deployment decision — a missing
   * value is a startup error, never a silent "AI on".
   */
  stage2Enabled: boolean;
  denylist: { paths: string[] };
  codeownersGlobs?: string[];
  trivialClasses: {
    docs: string[];
    lockfiles: { files: string[]; requireBotAuthor: string[] };
    /**
     * Generated artifacts. `requireDeterministicRegen` is an operator assertion that these are
     * machine-produced; `requireBotAuthor` is the part the engine can actually verify, and both
     * must hold before a generated file counts as trivial (see stage1_difftastic.ts).
     */
    generated: { files: string[]; requireDeterministicRegen: boolean; requireBotAuthor?: string[] };
  };
  /**
   * Comment text that is NOT inert. A comment-only change normally preserves an approval, but
   * these carry meaning to a compiler, linter or type checker — suppressing a security lint,
   * flipping a build constraint, disabling type checking — so a comment matching any of them
   * must reach a human.
   */
  directiveCommentPatterns: RegExp[];
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
 * Compiles a config-supplied pattern string into a RegExp, REJECTING the global and sticky
 * flags. Both make `RegExp.prototype.test` stateful via `lastIndex`: the same compiled regex is
 * reused across evaluations (stage0 injection canaries, stage2 sensitive patterns), so a /g
 * pattern would match on one call and silently MISS on the next — a security gate that fails
 * open every other invocation. Rejecting at load time turns that into a startup error.
 */
function compilePattern(raw: string, field: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(raw);
  const source = m ? m[1] : raw;
  const flags = m ? m[2] : "";
  if (flags.includes("g") || flags.includes("y")) {
    throw new Error(
      `${field}: pattern ${raw} uses the /${flags.includes("g") ? "g" : "y"} flag. ` +
      `Stateful regexes (lastIndex) intermittently miss matches when reused across evaluations; ` +
      `remove the flag.`,
    );
  }
  try {
    return new RegExp(source, flags);
  } catch (e: any) {
    throw new Error(`${field}: invalid regex ${raw}: ${e?.message ?? e}`);
  }
}

const patternArray = (field: string) =>
  z.array(z.string()).transform((arr) => arr.map((p) => compilePattern(p, field)));

// "owner/name" — one slash, no spaces, non-empty on both sides.
const repoSlug = z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be \"owner/name\"");

const ConfigSchema = z.object({
  difftasticBin: z.string().min(1).default("difft"),
  // Non-empty by contract: an empty array silently disables the self-governance gate entirely
  // (stage0 keys off cfg.selfGovernedRepos.includes(delta.repo)), so the engine would start
  // grading changes to its own gates. Fail at startup instead of degrading per-PR.
  selfGovernedRepos: z.array(repoSlug).min(1, "selfGovernedRepos must list at least one \"owner/name\" repo"),
  stage2Enabled: z.boolean(),
  denylist: z.object({ paths: z.array(z.string()) }),
  codeownersGlobs: z.array(z.string()).optional(),
  trivialClasses: z.object({
    docs: z.array(z.string()),
    lockfiles: z.object({ files: z.array(z.string()), requireBotAuthor: z.array(z.string()) }),
    generated: z.object({
      files: z.array(z.string()),
      requireDeterministicRegen: z.boolean(),
      requireBotAuthor: z.array(z.string()).optional(),
    }),
  }),
  directiveCommentPatterns: patternArray("directiveCommentPatterns"),
  injectionCanaries: patternArray("injectionCanaries"),
  sensitivePatterns: patternArray("sensitivePatterns"),
  thresholds: z.object({
    confThreshold: z.number().min(0).max(1),
    softMaxLines: z.number().int().positive(),
    softMaxFiles: z.number().int().positive(),
    hardMaxLines: z.number().int().positive(),
    hardMaxFiles: z.number().int().positive(),
    modelTimeoutMs: z.number().int().positive(),
    stalePendingMs: z.number().int().positive(),
  }),
});

/**
 * The model provider used when stage2Enabled is false. It is never called (the ladder
 * short-circuits before Stage 2), but the EngineConfig type requires an invoke function; this
 * one throws so that a wiring mistake surfaces loudly as a fail-closed dismiss rather than
 * silently returning a preserve-shaped verdict.
 */
function disabledModel(): EngineConfig["model"] {
  return {
    invoke: async () => {
      throw new Error("model provider not wired: this deployment runs deterministic-only (stage2Enabled=false)");
    },
    maxInputChars: 20000,
  };
}

/**
 * Selects the Stage 2 provider. Only reached when stage2Enabled is true; a deployment that has
 * the classifier switched off never constructs a provider at all, so a missing/incorrect model
 * configuration cannot affect it.
 *
 * An unknown provider name THROWS at startup rather than silently degrading: a deployment that
 * believes Stage 2 is on but has no working provider would dismiss every non-null delta with
 * `model_error`, which is safe but is a failure nobody asked for. Better to refuse to boot.
 */
async function resolveModel(name: string | undefined): Promise<EngineConfig["model"]> {
  const provider = (name || "bedrock").toLowerCase();
  if (provider === "bedrock") {
    const { bedrockModel } = await import("../model/bedrock.js");
    const modelId = process.env.MODEL_ID;
    if (!modelId) throw new Error("MODEL_ID must be set when stage2Enabled is true and MODEL_PROVIDER=bedrock");
    return bedrockModel({ modelId, region: process.env.AWS_REGION || "us-east-1" });
  }
  throw new Error(`unknown MODEL_PROVIDER "${provider}" (supported: bedrock)`);
}

/**
 * Loads the runtime configuration from the JSON file at AFE_CONFIG_PATH (default
 * ./config/config.json), applying a small set of environment overrides.
 *
 * Fail-Closed Invariant: any problem — missing file, malformed JSON, schema violation, a
 * stateful regex flag — THROWS. Callers (the ladder orchestrator, the Lambda handler) convert
 * that into a fail-closed dismiss / no check write; the engine never runs on a config it could
 * not fully validate.
 */
export async function loadConfig(): Promise<EngineConfig> {
  const path = process.env.AFE_CONFIG_PATH || "config/config.json";

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    throw new Error(`loadConfig: could not read/parse config at ${path}: ${e?.message ?? e}`);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`loadConfig: invalid config at ${path}: ${issues}`);
  }

  const cfg = parsed.data;

  // Environment overrides, deliberately few. DIFFT_BIN exists because the binary's path differs
  // per packaging (container /usr/local/bin/difft, Lambda layer /opt/bin/difft) while the rest
  // of the config is identical. AFE_SELF_GOVERNED_REPOS lets a fork declare its own identity
  // without forking the config file; it is still validated (non-empty, "owner/name").
  const difftasticBin = process.env.DIFFT_BIN || cfg.difftasticBin;
  let selfGovernedRepos = cfg.selfGovernedRepos;
  if (process.env.AFE_SELF_GOVERNED_REPOS) {
    const list = process.env.AFE_SELF_GOVERNED_REPOS.split(",").map((s) => s.trim()).filter(Boolean);
    const check = z.array(repoSlug).min(1).safeParse(list);
    if (!check.success) {
      throw new Error("loadConfig: AFE_SELF_GOVERNED_REPOS must be a non-empty comma-separated list of \"owner/name\"");
    }
    selfGovernedRepos = check.data;
  }
  // Only ever able to TIGHTEN: the env var can disable Stage 2, never enable it against a
  // config that has it off.
  const stage2Enabled = process.env.AFE_STAGE2_ENABLED === "false" ? false : cfg.stage2Enabled;

  return {
    ...cfg,
    difftasticBin,
    selfGovernedRepos,
    stage2Enabled,
    model: stage2Enabled ? await resolveModel(process.env.MODEL_PROVIDER) : disabledModel(),
  };
}
