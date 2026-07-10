import { minimatch } from "minimatch";
import { Decision, Delta, dismiss, ReasonCode } from "./types.js";
import { EngineConfig } from "../config/schema.js";

// Stage 0: deterministic categorical dismissal. NO model. NO network.
// Returns a Decision (always DISMISS) if any hard rule trips, else null (continue).
export function stage0(delta: Delta, cfg: EngineConfig): Decision | null {
  // 1. Force-push / rebase-with-content / base change → the classic hijack surface.
  if (delta.forcePushed) return dismiss(0, "force_push", "History was rewritten since approval.");
  if (delta.baseChanged) {
    // NOTE: base change alone is NOT a dismiss if the PR's own tree delta is empty —
    // that merge-base-only case is handled (preserved) in Stage 1. Here we only dismiss
    // if the base changed AND there is real content change, which Stage 1 will also catch.
    // We let it fall through so Stage 1 can distinguish. (No dismiss here.)
  }

  // 2. A commit by anyone other than the PR author → someone pushed onto an approved branch.
  const foreign = delta.commitAuthors.filter((a) => a && a !== delta.prAuthor);
  if (foreign.length > 0) {
    return dismiss(0, "foreign_author_commit",
      `Commits since approval authored by non-PR-author: ${[...new Set(foreign)].join(", ")}.`);
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
  const matchOpts = { dot: true, nocase: false };
  for (const file of delta.changedFiles) {
    for (const glob of cfg.denylist.paths) {
      if (minimatch(file, glob, matchOpts)) {
        return dismiss(0, "denylist_path", `Privileged path changed: ${file} (matched ${glob}).`);
      }
    }
    for (const glob of cfg.codeownersGlobs ?? []) {
      if (minimatch(file, glob, matchOpts)) {
        return dismiss(0, "codeowners_path", `CODEOWNERS-governed path changed: ${file}.`);
      }
    }
  }

  // 5. Injection canaries in the diff text → dismiss AND ensure Stage 2 never runs on this.
  const haystack = Object.values(delta.patchByFile).join("\n");
  for (const rx of cfg.injectionCanaries) {
    if (rx.test(haystack)) {
      return dismiss(0, "injection_canary",
        "Diff content contains classifier-manipulation patterns; forcing human review.");
    }
  }

  return null; // no hard rule tripped → continue to Stage 1
}
