import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unlink } from "node:fs/promises";
import { minimatch } from "minimatch";
import { Decision, Delta, preserve } from "./types.js";
import { EngineConfig } from "../config/schema.js";

const run = promisify(execFile);

/**
 * Executes Stage 1: deterministic semantic diffing via difftastic. NO model.
 * Fail-Closed Invariant: Returns a PRESERVE decision ONLY if the change is provably null
 * or restricted to trivial files. Any ambiguity, parsing failure, or structural change
 * results in returning null (to continue to the next stage) or ultimately failing closed.
 *
 * @param delta - The change context.
 * @param cfg - The runtime engine configuration.
 * @returns A PRESERVE Decision if the change is safe, or null if it requires further scrutiny.
 */
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
  
  const results = [];
  const CONCURRENCY = 10;
  for (let i = 0; i < delta.changedFiles.length; i += CONCURRENCY) {
    const chunk = delta.changedFiles.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (file) => {
        const structural = await difftasticStructuralChange(file, delta, cfg);
        return { file, structural };
      })
    );
    results.push(...chunkResults);
  }

  for (const { file, structural } of results) {
    if (structural === "unsupported") {
      allStructurallyIdentical = false; // fail closed: can't prove null → don't preserve here
      reports[file] = "unsupported-language";
    } else {
      reports[file] = structural ? "structural-change" : "identical";
      if (structural) { allStructurallyIdentical = false; }
    }
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

/**
 * Checks if a file contains structural changes via difftastic.
 * Fail-Closed Invariant: Any error executing the diff or unsupported languages return "unsupported",
 * which forces the caller to treat it as a failure to prove identity, thus preventing a PRESERVE.
 *
 * @param file - The file path to diff.
 * @param delta - The change context.
 * @param cfg - The runtime engine configuration.
 * @returns false if identical, true if structurally changed, or "unsupported" on failure/unsupported language.
 */
async function difftasticStructuralChange(
  file: string, delta: Delta, cfg: EngineConfig,
): Promise<boolean | "unsupported"> {
  let approvedTmp: string | undefined;
  let headTmp: string | undefined;
  try {
    // difft --exit-code returns 0 when there are NO structural changes, 1 when there are.
    // We diff the approved blob vs head blob for this path. (Blobs fetched upstream and
    // written to temp files by the caller in the real impl; here we pass patch context.)
    const blobs = await materializeBlobs(file, delta);
    approvedTmp = blobs.path;
    headTmp = blobs.head;
    
    // [FIX] Unhandled Errors:
    // 1. execFile buffers stdout up to maxBuffer (default 1MB). difftastic with
    //    '--display json' can easily output >1MB for large diffs, causing an unhandled
    //    ERR_CHILD_PROCESS_STDIO_MAXBUFFER throw. We increase the buffer to 10MB.
    // 2. difftastic could hang indefinitely on malformed syntax. We add a timeout
    //    so the engine does not stall.
    await run(cfg.difftasticBin, ["--exit-code", "--display", "json", approvedTmp, headTmp], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });
    
    return false; // exit 0 → no structural change
  } catch (e: any) {
    if (e && e.code === 1) return true;                 // structural change
    if (e && e.code === 2) return "unsupported";        // difft: parse/other → treat as unsupported
    return "unsupported";                                // unknown → fail closed
  } finally {
    if (approvedTmp) await unlink(approvedTmp).catch(() => {});
    if (headTmp) await unlink(headTmp).catch(() => {});
  }
}

/**
 * Determines if a modified file belongs to an allowlisted trivial class.
 * Fail-Closed Invariant: If a file does not strictly match a defined trivial pattern
 * and specific author constraints, it defaults to returning false, ensuring it receives scrutiny.
 *
 * @param file - The file path to check.
 * @param delta - The change context.
 * @param cfg - The runtime engine configuration.
 * @returns true if the file is strictly trivial, false otherwise.
 */
function isTrivialClass(file: string, delta: Delta, cfg: EngineConfig): boolean {
  const tc = cfg.trivialClasses;
  if (tc.docs.some((g) => minimatch(file, g, { dot: true }))) return true;
  if (tc.lockfiles.files.some((g) => minimatch(file, g, { dot: true }))) {
    // Only trivial if ALL commit authors are approved bots.
    // [FIX] Logic Bypass: `every()` returns true for empty arrays!
    // If commitAuthors is empty, an attacker could bypass the lockfile author restriction.
    return delta.commitAuthors.length > 0 && 
           delta.commitAuthors.every((a) => tc.lockfiles.requireBotAuthor.includes(a));
  }
  if (tc.generated.requireDeterministicRegen &&
      tc.generated.files.some((g) => minimatch(file, g, { dot: true }))) return true;
  return false;
}

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Materializes blobs for difftastic to compare.
 * Fail-Closed Invariant: If blobs cannot be fetched or written (e.g., API errors, missing refs),
 * this function throws an error, triggering the orchestrator's master fail-closed mechanism.
 *
 * @param file - The file to fetch.
 * @param delta - The change context.
 * @returns An object containing paths to the materialized temp files.
 */
async function materializeBlobs(file: string, delta: Delta): Promise<{ path: string; head: string }> {
  if (!delta.octokit || !delta.owner || !delta.repo) {
    throw new Error("materializeBlobs requires octokit, owner, and repo on Delta");
  }

  const fetchBlob = async (ref: string) => {
    try {
      const resp = await delta.octokit!.repos.getContent({
        owner: delta.owner!,
        repo: delta.repo!,
        path: file,
        ref: ref,
      });
      if (Array.isArray(resp.data) || resp.data.type !== "file") {
        return ""; // Not a file or missing
      }
      return Buffer.from(resp.data.content, "base64").toString("utf-8");
    } catch (e: any) {
      if (e.status === 404) return ""; // File might be newly created or deleted
      throw e;
    }
  };

  const [approvedContent, headContent] = await Promise.all([
    fetchBlob(delta.approvedSha),
    fetchBlob(delta.headSha)
  ]);

  const prefix = randomBytes(8).toString("hex");
  const approvedPath = join(tmpdir(), `${prefix}_approved_${file.replace(/\\W+/g, "_")}`);
  const headPath = join(tmpdir(), `${prefix}_head_${file.replace(/\\W+/g, "_")}`);

  await Promise.all([
    writeFile(approvedPath, approvedContent, "utf8"),
    writeFile(headPath, headContent, "utf8")
  ]);

  return { path: approvedPath, head: headPath };
}
