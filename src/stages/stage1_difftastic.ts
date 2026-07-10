import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import { Decision, Delta, preserve } from "./types.js";
import { EngineConfig } from "../config/schema.js";

const run = promisify(execFile);

// Stage 1: deterministic semantic diffing via difftastic. NO model.
// Returns PRESERVE if the change is provably null; null (continue) otherwise.
// Fails CLOSED: any ambiguity, parse gap, or structural change → continue (never preserve).
export async function stage1(delta: Delta, cfg: EngineConfig): Promise<Decision | null> {
  // (a) Merge-base-only: PR's own tree delta vs approvedSha is empty → the "change"
  //     is entirely an unrelated PR moving the merge base. GitHub dismisses this today
  //     for no reason; we preserve it.
  if (delta.baseChanged && delta.changedFiles.length === 0) {
    return preserve(1, "merge_base_only",
      "PR content unchanged since approval; only the merge base moved (unrelated PR merged).");
  }

  // (b) AST-identical check: run difftastic structurally over each changed file's patch.
  //     If difftastic reports zero structural changes across ALL files → whitespace/format/
  //     comment-only → preserve.
  let allStructurallyIdentical = delta.changedFiles.length > 0;
  const reports: Record<string, string> = {};
  for (const file of delta.changedFiles) {
    const structural = await difftasticStructuralChange(file, delta, cfg);
    if (structural === "unsupported") {
      allStructurallyIdentical = false; // fail closed: can't prove null → don't preserve here
      reports[file] = "unsupported-language";
      break;
    }
    reports[file] = structural ? "structural-change" : "identical";
    if (structural) { allStructurallyIdentical = false; break; }
  }
  if (allStructurallyIdentical) {
    return preserve(1, "ast_identical",
      "Zero semantic changes since approval (whitespace/formatting/comments only).",
      { difftastic: reports });
  }

  // (c) Trivial-class-only: every changed file is in an allowlisted trivial class.
  if (delta.changedFiles.length > 0 && delta.changedFiles.every((f) => isTrivialClass(f, delta, cfg))) {
    return preserve(1, "trivial_class",
      "All changes are in allowlisted trivial classes (docs / bot-only lockfiles / deterministic generated).",
      { files: delta.changedFiles });
  }

  return null; // real semantic change on non-trivial paths → Stage 2
}

// Returns true if difftastic finds a structural (non-formatting) change, false if identical,
// "unsupported" if difftastic can't parse the language (→ caller fails closed).
async function difftasticStructuralChange(
  file: string, delta: Delta, cfg: EngineConfig,
): Promise<boolean | "unsupported"> {
  try {
    // difft --exit-code returns 0 when there are NO structural changes, 1 when there are.
    // We diff the approved blob vs head blob for this path. (Blobs fetched upstream and
    // written to temp files by the caller in the real impl; here we pass patch context.)
    const { path: approvedTmp, head: headTmp } = await materializeBlobs(file, delta);
    await run(cfg.difftasticBin, ["--exit-code", "--display", "json", approvedTmp, headTmp]);
    return false; // exit 0 → no structural change
  } catch (e: any) {
    if (e && e.code === 1) return true;                 // structural change
    if (e && e.code === 2) return "unsupported";        // difft: parse/other → treat as unsupported
    return "unsupported";                                // unknown → fail closed
  }
}

function isTrivialClass(file: string, delta: Delta, cfg: EngineConfig): boolean {
  const tc = cfg.trivialClasses;
  if (tc.docs.some((g) => minimatch(file, g, { dot: true }))) return true;
  if (tc.lockfiles.files.some((g) => minimatch(file, g, { dot: true }))) {
    // Only trivial if ALL commit authors are approved bots.
    return delta.commitAuthors.every((a) => tc.lockfiles.requireBotAuthor.includes(a));
  }
  if (tc.generated.requireDeterministicRegen &&
      tc.generated.files.some((g) => minimatch(file, g, { dot: true }))) return true;
  return false;
}

// Placeholder: real impl fetches the two blob versions via the GitHub API and writes temp files.
async function materializeBlobs(_file: string, _delta: Delta): Promise<{ path: string; head: string }> {
  throw new Error("materializeBlobs must be wired to github/pr.ts blob fetch");
}
