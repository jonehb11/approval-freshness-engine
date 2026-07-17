import { Minimatch } from "minimatch";
import { Decision, Delta, dismiss, ReasonCode } from "./types.js";
import { EngineConfig } from "../config/schema.js";

/**
 * The engine's own control surface. If a PR against a self-governed repo (see
 * cfg.selfGovernedRepos) touches ANY of these, the engine withholds its opinion and dismisses:
 * it will never *preserve* an approval on a change to the gates, prompt, echo, workflows, or
 * ruleset that judge it. Such PRs always get fresh human review (CODEOWNERS-required security
 * review + native re-approval).
 *
 * This list is a HARDCODED CODE CONSTANT, deliberately NOT sourced from the mutable EngineConfig,
 * so a PR (or a compromised config) can never loosen the boundary that protects the engine.
 * Kept 1:1 in sync with .github/CODEOWNERS (see the sync-guard test in
 * test/self_governance.test.ts).
 */
export const SELF_GOVERNANCE_GLOBS: string[] = [
  ".github/**",
  "deploy/rulesets/**",
  "deploy/helm/**",
  "deploy/terraform/**",
  "src/config/**",
  "config/**",
  "src/model/**",
  "src/stages/**",
  // The whole src/github/ directory, not just the echo + actuator: pr.ts holds the
  // identity-resolution and force-push logic, auth.ts holds webhook signature verification —
  // both are as much "the gate" as the gates themselves. Directory-wide coverage also means
  // any future file added here is control surface by default rather than by remembering.
  "src/github/**",
  "src/index.ts",
  "src/audit/**",
  // Prod-hardening runtime core: the coalescing/serializing/bounded work queue that decides
  // WHEN and IN WHAT ORDER PR evaluations run. A compromised queue could reorder, drop, or
  // duplicate evaluations across parallel PRs (e.g. resurrect a superseded/coalesced task, or
  // let two same-key tasks race between an evaluation and the fresh-approval echo) — that is
  // as much control surface as the stages it schedules. Added together with .github/CODEOWNERS
  // (bidirectional sync-guard test in test/self_governance.test.ts).
  "src/runtime/**",
  // Metrics/observability wiring is instrumented directly into the queue + webhook hot path
  // (task outcomes, coalesce/reject counts) — grouped with src/runtime/** for the same reason.
  "src/observability/**",
  "test/no_approve_path.test.ts",
  "test/check_conclusion_guard.test.ts",
];

// Shared match options for every glob compiled below: dot (match dotfiles like .github/), nocase
// (case-insensitive — see the [FIX] comments at each call site below for why casing evasion
// matters). Identical to the inline `{ dot: true, nocase: true }` literals this replaces.
const MATCH_OPTS = { dot: true, nocase: true };

/**
 * Precompiled Minimatch instances for one EngineConfig object. `minimatch(file, glob, opts)`
 * recompiles the glob's regex on every single call, and stage0 calls it up to file × glob times
 * per evaluation. This cache compiles each glob list to Minimatch instances once per distinct
 * EngineConfig object reference and reuses them across every stage0() call that receives that
 * same config — pure micro-perf, zero behavior change: same pattern strings, same options, same
 * `.match(file)` semantics as the `minimatch(file, glob, opts)` calls it replaces.
 */
interface CompiledMatchers {
  selfGovernance: Minimatch[];
  denylist: Minimatch[];
  codeowners: Minimatch[];
}

// Keyed by EngineConfig object identity (not content) — a WeakMap so a config object no longer
// referenced anywhere else (e.g. after a config reload in a long-running process) doesn't pin
// its compiled matchers in memory forever.
const matcherCache = new WeakMap<EngineConfig, CompiledMatchers>();

// SELF_GOVERNANCE_GLOBS is a module-level constant independent of any EngineConfig, so it is
// compiled once, lazily (not eagerly at import time, to keep this module side-effect-free until
// stage0() actually runs), and shared across every config's CompiledMatchers.
let compiledSelfGovernanceGlobs: Minimatch[] | null = null;
function getSelfGovernanceMatchers(): Minimatch[] {
  if (!compiledSelfGovernanceGlobs) {
    compiledSelfGovernanceGlobs = SELF_GOVERNANCE_GLOBS.map((g) => new Minimatch(g, MATCH_OPTS));
  }
  return compiledSelfGovernanceGlobs;
}

function getCompiledMatchers(cfg: EngineConfig): CompiledMatchers {
  let compiled = matcherCache.get(cfg);
  if (!compiled) {
    compiled = {
      selfGovernance: getSelfGovernanceMatchers(),
      denylist: cfg.denylist.paths.map((g) => new Minimatch(g, MATCH_OPTS)),
      codeowners: (cfg.codeownersGlobs ?? []).map((g) => new Minimatch(g, MATCH_OPTS)),
    };
    matcherCache.set(cfg, compiled);
  }
  return compiled;
}

// Test-only observability hook: lets tests assert the WeakMap cache above is actually reused
// across repeated stage0() calls that pass the same EngineConfig object reference, without
// exposing the compiled Minimatch internals themselves. Not read by any runtime code path.
export function __stage0MatcherCacheHasForTest(cfg: EngineConfig): boolean {
  return matcherCache.has(cfg);
}

/**
 * Stage 0: deterministic categorical dismissal. NO model. NO network.
 * Fail-Closed Invariant: This stage defaults to returning a DISMISS decision immediately if any
 * unsafe or rewritten history conditions are met. If no rules trip, it returns null,
 * allowing the ladder to proceed safely to the next stage.
 *
 * @param delta - The change context.
 * @param cfg - The runtime engine configuration.
 * @returns A DISMISS Decision if a hard rule trips, or null if it is safe to proceed.
 */
export function stage0(delta: Delta, cfg: EngineConfig): Decision | null {
  // Lazily compiled + cached per cfg object identity (see getCompiledMatchers above); reused by
  // both rule 0 (self-governance) and rule 4 (denylist/codeowners) below.
  const matchers = getCompiledMatchers(cfg);

  // 0. Self-governance: the engine cannot grade changes to its OWN control surface.
  // The engine always evaluates against DEPLOYED config (a PR can never loosen the rules it is
  // judged under mid-flight); this rule closes the remaining boundary — the engine never
  // *preserves* an approval on a PR that changes its own gates, prompt, echo, workflows, or
  // ruleset. SELF_GOVERNANCE_GLOBS is a code constant (not config) so mutable config cannot
  // widen what the engine is allowed to self-grade. nocase guards against casing-evasion.
  if (cfg.selfGovernedRepos.includes(delta.repo)) {
    for (const file of delta.changedFiles) {
      for (const m of matchers.selfGovernance) {
        if (m.match(file)) {
          return dismiss(0, "self_governance",
            `Changed file ${file} is part of the engine's own control surface (matched ${m.pattern}); the engine does not evaluate changes to its own control surface; human review required.`);
        }
      }
    }
  }

  // 1. Force-push / rebase-with-content / base change → the classic hijack surface.
  if (delta.forcePushed) return dismiss(0, "force_push", "History was rewritten since approval.");

  // NOTE: base change alone is NOT a dismiss if the PR's own tree delta is empty —
  // that merge-base-only case is handled (preserved) in Stage 1. Here we only dismiss
  // if the base changed AND there is real content change, which Stage 1 will also catch.
  // We let it fall through so Stage 1 can distinguish. (No dismiss here.)

  // 2. A commit by anyone other than the PR author → someone pushed onto an approved branch.
  // Identity contract: commitAuthors entries are GitHub-verified account logins or null.
  // null means GitHub could not resolve a verified account (buildDelta never falls back to
  // attacker-controlled git-author metadata) and is CATEGORICALLY foreign.
  // [FIX] Logic Bypass: We must not ignore falsy/null authors. A null/unverified author
  // is still a foreign author. Ignoring them would let an attacker push commits with an
  // unresolvable identity and bypass this check.
  const foreign = delta.commitAuthors.filter((a) => !a || a !== delta.prAuthor);
  if (foreign.length > 0) {
    return dismiss(0, "foreign_author_commit",
      `Commits since approval authored by non-PR-author: ${[...new Set(foreign)].map(a => a || "Unlinked/Anonymous").join(", ")}.`);
  }

  // 3. Hard size caps: a "trivial" change that is enormous is not trivial.
  if (delta.addedLines + delta.removedLines > cfg.thresholds.hardMaxLines) {
    return dismiss(0, "hard_size_cap",
      `Delta ${delta.addedLines + delta.removedLines} lines exceeds hard cap ${cfg.thresholds.hardMaxLines}.`);
  }
  if (delta.changedFiles.length > cfg.thresholds.hardMaxFiles) {
    return dismiss(0, "hard_size_cap",
      `Delta touches ${delta.changedFiles.length} files, exceeds hard cap ${cfg.thresholds.hardMaxFiles}.`);
  }

  // 4. Privileged-path denylist — ANY match dismisses, before any AI can ever see it.
  // [FIX] Logic Bypass: nocase must be true. Attackers can evade path-based denylists
  // on many platforms simply by changing the filename casing (e.g., .Github/workflows).
  for (const file of delta.changedFiles) {
    for (const m of matchers.denylist) {
      if (m.match(file)) {
        return dismiss(0, "denylist_path", `Privileged path changed: ${file} (matched ${m.pattern}).`);
      }
    }
    for (const m of matchers.codeowners) {
      if (m.match(file)) {
        return dismiss(0, "codeowners_path", `CODEOWNERS-governed path changed: ${file}.`);
      }
    }
  }

  // 5. Injection canaries in the diff text → dismiss AND ensure Stage 2 never runs on this.
  // [FIX] ReDoS Mitigation: Avoid concatenating all patches into a single massive string.
  // Instead, test each file's patch individually. Additionally, if a patch is extremely
  // large, we dismiss it immediately rather than evaluating it, protecting the regex
  // engine from catastrophic backtracking on attacker-controlled multi-megabyte strings.
  for (const [file, patch] of Object.entries(delta.patchByFile)) {
    if (patch.length > 500_000) {
      return dismiss(0, "hard_size_cap", `Patch for ${file} exceeds safe size for canary regex evaluation.`);
    }
    for (const rx of cfg.injectionCanaries) {
      if (rx.test(patch)) {
        return dismiss(0, "injection_canary",
          "Diff content contains classifier-manipulation patterns; forcing human review.");
      }
    }
  }

  return null; // no hard rule tripped → continue to Stage 1
}
