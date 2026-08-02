import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unlink, mkdtemp, writeFile, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, extname, dirname } from "node:path";
import { minimatch } from "minimatch";
import { Decision, Delta, preserve } from "./types.js";
import { EngineConfig } from "../config/schema.js";

const run = promisify(execFile);

// GLOBAL difftastic process bound, shared across ALL concurrent evaluations. The per-evaluation
// chunking below (CONCURRENCY = 10) only bounds one evaluation; with the work queue running up
// to AFE_WORKER_CONCURRENCY (default 16) evaluations at once, the unshared worst case would be
// 16 × 10 = 160 concurrent difftastic OS processes against a ~1-CPU container — fork/OOM/CPU
// thrash. difftastic bursts CPU, so the process-wide ceiling is sized to the actual CPU budget
// (never above 8), not to task concurrency. Overridable via AFE_DIFFT_MAX_PROCS for larger
// nodes. Plain promise-chain semaphore: acquire returns a release function; FIFO fairness.
const MAX_DIFFT_PROCS = (() => {
  const raw = parseInt(process.env.AFE_DIFFT_MAX_PROCS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return Math.max(1, Math.min(8, availableParallelism()));
})();

let difftActive = 0;
const difftWaiters: Array<() => void> = [];

async function acquireDifftSlot(): Promise<() => void> {
  if (difftActive < MAX_DIFFT_PROCS) {
    difftActive++;
  } else {
    await new Promise<void>((resolve) => difftWaiters.push(resolve));
    difftActive++;
  }
  let released = false;
  return () => {
    if (released) return; // idempotent: a double release must never over-credit the semaphore
    released = true;
    difftActive--;
    const next = difftWaiters.shift();
    if (next) next();
  };
}

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

  // Per-file structural verdicts are the evidence behind an ast_identical preserve (or its
  // absence). Logging them makes "why wasn't this preserved?" answerable from the audit trail
  // instead of by re-running difftastic by hand.
  console.log(`[stage1] verdicts ${JSON.stringify(results.map((r) => ({ f: r.file, structural: r.structural })))}`);

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
    // Process-wide semaphore (see MAX_DIFFT_PROCS above): bounds TOTAL concurrent difft
    // processes across every in-flight evaluation, not just this one.
    const release = await acquireDifftSlot();
    try {
      // Only the EXIT CODE is load-bearing here (0 = no syntactic changes, 1 = structural
      // change); stdout is never parsed. It must not ask for `--display json`: difftastic
      // treats JSON output as an unstable feature and exits 2 with
      // "set the environment variable DFT_UNSTABLE=yes" unless that opt-in is present — and
      // exit 2 is mapped to "unsupported", which silently disabled the ENTIRE deterministic
      // preserve path (every file looked unparseable, so ast_identical could never fire).
      // Verified against difftastic 0.69.0, the version pinned in the Dockerfile and the
      // Lambda layer. Keeping the default display costs nothing and cannot regress this way.
      await run(cfg.difftasticBin, ["--exit-code", approvedTmp, headTmp], {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        // Belt and braces: if a future change does want JSON, the opt-in is already here, so
        // the same silent-disable cannot recur.
        env: { ...process.env, DFT_UNSTABLE: "yes" },
      });
    } finally {
      release();
    }

    return false; // exit 0 → no structural change
  } catch (e: any) {
    if (e && e.code === 1) return true;                 // structural change
    // Anything that is not "clean run" or "structural change" must be visible. Exit code 2
    // (difftastic could not parse / errored) and every unexpected failure look identical from
    // the outside — "unsupported" — which silently disables the deterministic preserve path
    // while the engine still reports healthy. Log difftastic's own stderr so the difference
    // between "this language has no grammar" and "the binary is broken" is diagnosable.
    console.error(`[stage1] ${file}: difftastic did not decide (code=${e?.code ?? "none"}): ${String(e?.stderr || e?.message || e).slice(0, 400)}`);
    if (e && e.code === 2) return "unsupported";        // difft: parse/other → treat as unsupported
    // Anything else is fail-closed too, but it must never be SILENT: a missing/unexecutable
    // difftastic binary, a blob fetch failure, or a timeout all land here and all look
    // identical to "unsupported language" from the outside — which silently turns the entire
    // deterministic preserve path off while the engine still reports healthy. Log enough to
    // tell those apart; this line is how an operator discovers Stage 1 is dark.
    return "unsupported";                                // unknown → fail closed
  } finally {
    if (approvedTmp) await unlink(approvedTmp).catch(() => {});
    if (headTmp) await unlink(headTmp).catch(() => {});
    // Both blobs live in one mkdtemp directory (materializeBlobs); remove it too, or a
    // long-lived process leaks an empty directory per file per evaluation into /tmp — which on
    // this deployment is a size-capped emptyDir / Lambda's 512MB ephemeral store.
    const dir = approvedTmp ? dirname(approvedTmp) : headTmp ? dirname(headTmp) : undefined;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
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
    // A null/unverified author can never satisfy the bot-author allowlist (identity is only a
    // GitHub-resolved login); guard the null before the string-only includes() check.
    return delta.commitAuthors.length > 0 &&
           delta.commitAuthors.every((a) => a !== null && tc.lockfiles.requireBotAuthor.includes(a));
  }
  if (tc.generated.files.some((g) => minimatch(file, g, { dot: true }))) {
    // `requireDeterministicRegen` is a POLICY ASSERTION, not a verification: nothing here re-runs
    // the generator, so on its own it only ever meant "the operator believes these are
    // regenerable". That made a generated-file preserve depend on the FILENAME alone — a
    // hand-edited `foo.gen.ts` carrying arbitrary code would have been treated as trivial.
    //
    // Authorship is the part that can actually be checked, and it is the property that makes the
    // assertion credible: a genuinely regenerated artifact is written by CI or a bot, not typed by
    // a human. Same shape as the lockfile rule, including the empty-array guard — `every()` is
    // vacuously true for an empty list, so an unattributable commit set must never qualify.
    if (!tc.generated.requireDeterministicRegen) return false;
    const allowed = tc.generated.requireBotAuthor ?? [];
    if (allowed.length === 0) return false; // no allowlist configured → cannot qualify
    return delta.commitAuthors.length > 0 &&
           delta.commitAuthors.every((a) => a !== null && allowed.includes(a));
  }
  return false;
}

/**
 * Materializes blobs for difftastic to compare.
 * Fail-Closed Invariant: If blobs cannot be fetched or written (e.g., API errors, missing refs),
 * this function throws an error, triggering the orchestrator's master fail-closed mechanism.
 *
 * @param _file - The file to fetch.
 * @param _delta - The change context.
 * @returns An object containing paths to the materialized temp files.
 */
async function materializeBlobs(file: string, delta: Delta): Promise<{ path: string; head: string }> {
  const src = delta.blobSource;
  if (!src) {
    // No live handle (unit tests, or a caller that failed to wire it): cannot prove anything.
    // The caller maps this throw to "unsupported", which forbids an ast_identical preserve —
    // fail closed by construction.
    throw new Error("materializeBlobs: delta.blobSource is not wired");
  }

  const dir = await mkdtemp(join(tmpdir(), "afe-"));

  // Fetch each version by its exact commit SHA — never by branch ref, which could move between
  // the two fetches and make difftastic compare a pair of blobs that never coexisted.
  const fetchBlob = async (ref: string): Promise<string> => {
    const res = await src.octokit.repos.getContent({
      owner: src.owner, repo: src.repo, path: file, ref,
      mediaType: { format: "raw" },
    });
    // With format: "raw" Octokit hands back the file body as a string. Anything else (a
    // directory listing, a submodule, an over-size file GitHub refuses to inline) is not
    // something we can prove identical — throw, and fail closed.
    if (typeof res.data !== "string") {
      throw new Error(`materializeBlobs: ${file}@${ref} is not raw text content`);
    }
    return res.data;
  };

  // Preserve the real extension: difftastic picks its tree-sitter grammar from the file name,
  // so a temp file called "abc123" would parse as plain text and report every change as
  // structural — silently turning provable-null deltas into dismissals.
  const ext = extname(file);
  const write = async (name: string, body: string): Promise<string> => {
    const p = join(dir, `${name}${ext}`);
    await writeFile(p, body, "utf8");
    return p;
  };

  const [approvedBody, headBody] = await Promise.all([
    fetchBlob(delta.approvedSha),
    fetchBlob(delta.headSha),
  ]);

  return {
    path: await write("approved", approvedBody),
    head: await write("head", headBody),
  };
}
