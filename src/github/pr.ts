import { Octokit } from "@octokit/rest";
import { Delta } from "../stages/types.js";
// withRateLimit used to be defined here (byte-for-byte duplicated in actuator.ts too). It now
// lives in client.ts as the single implementation; both files import it. Behavior unchanged.
import { withRateLimit } from "./client.js";

/**
 * Resolves the approved state and builds the Delta object.
 * Fail-Closed Invariant: If commit comparison fails or metadata cannot be fetched from GitHub,
 * an error is thrown, terminating the process and triggering the orchestrator's fail-closed response.
 *
 * @param octokit - The GitHub API client.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param pr - The PR payload data.
 * @param approvedSha - The commit SHA that was approved.
 * @param headSha - The current PR head SHA.
 * @param opts - opts.webhookForced is the push event payload's `forced` flag as reported by
 *   the caller. A push-event handler (deploy-time ladder wiring; not yet routed in src/index.ts) passes it through; the pull_request "synchronize" path
 *   has no such flag and passes false, relying instead on the compare-status corroboration
 *   below (defense in depth: history rewrites are detected even if the push webhook was lost).
 * @returns A promise resolving to the unified Delta object.
 */
export async function buildDelta(
  octokit: Octokit, owner: string, repo: string, pr: any, approvedSha: string, headSha: string,
  opts: { webhookForced: boolean },
): Promise<Delta> {
  const files: any[] = [];
  const commits: any[] = [];
  let page = 1;
  const per_page = 100;
  // Compare status from the FIRST page for the basehead `${approvedSha}...${headSha}`.
  // "diverged"/"behind" mean headSha no longer contains approvedSha → history was rewritten
  // since approval, regardless of what any webhook reported.
  let firstStatus: string | undefined;

  // Optimize and handle pagination using a loop
  while (true) {
    const cmp = await withRateLimit(() => octokit.repos.compareCommitsWithBasehead({
      owner, repo, basehead: `${approvedSha}...${headSha}`,
      per_page, page,
    }));

    if (page === 1) firstStatus = cmp.data.status;
    if (cmp.data.files) files.push(...cmp.data.files);
    if (cmp.data.commits) commits.push(...cmp.data.commits);

    // Stop if we receive fewer items than the per_page limit, meaning we've hit the last page
    if ((cmp.data.commits?.length ?? 0) < per_page && (cmp.data.files?.length ?? 0) < per_page) {
      break;
    }
    page++;
  }

  // ── Update-branch detection (the "merge base only" case) ────────────────────────────────────
  // A three-dot compare `approvedSha...headSha` answers "what is in head that is not in the
  // approved commit". When the developer clicks GitHub's "Update branch" button, head becomes a
  // MERGE COMMIT whose first parent is the old head and whose second parent is the base branch
  // tip — so the compare legitimately reports every commit and file the BASE branch gained,
  // none of which the PR author wrote and none of which is a change to the PR's own proposal.
  // Left uncorrected, that reads as a large foreign-author delta and dismisses (the bug recorded
  // in docs/FAILURE-MODES.md §4.5), which is exactly the case this engine exists to preserve.
  //
  // detectUpdateBranchMerge below returns true ONLY when the PR's own content is provably
  // unchanged. Everything about the identity contract is preserved: this cannot let a foreign
  // CONTENT change through, because a merge that resolved conflicts by editing the PR's files
  // produces a different own-delta and fails the equality check.
  const updateBranchOnly = await detectUpdateBranchMerge(octokit, owner, repo, approvedSha, headSha);

  if (updateBranchOnly) {
    return {
      repo: `${owner}/${repo}`,
      approvedSha, headSha,
      // Empty tree delta + baseChanged is precisely the (a) branch of stage1: "PR content
      // unchanged since approval; only the merge base moved". No file was proposed anew, so
      // there is nothing for stages 0/1/2 to judge and no author to attribute a change to.
      changedFiles: [],
      addedLines: 0,
      removedLines: 0,
      commitAuthors: [],
      prAuthor: pr.user?.login ?? "",
      forcePushed: opts.webhookForced || firstStatus === "diverged" || firstStatus === "behind",
      baseChanged: true,
      patchByFile: {},
      blobSource: { octokit, owner, repo },
    };
  }

  return {
    repo: `${owner}/${repo}`,
    approvedSha, headSha,
    // BOTH sides of a rename. GitHub reports a renamed file once, with `filename` set to the NEW
    // path and `previous_filename` to the old one. Reading only `filename` meant a privileged file
    // could be renamed OUT of its protected path — `.github/workflows/ci.yml` → `docs/old.txt` —
    // and the denylist would only ever see the harmless destination, so deleting a CI job by
    // moving it away could be preserved. Both paths are evaluated, so a rename is privileged if
    // EITHER end of it is.
    changedFiles: [...new Set(files.flatMap((f) => (
      f.previous_filename && f.previous_filename !== f.filename
        ? [f.filename, f.previous_filename]
        : [f.filename]
    )))],
    addedLines: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    removedLines: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    // SECURITY: identity is ONLY the GitHub-resolved account login (c.author.login). We never
    // fall back to git-author metadata, which is attacker-controlled (`git config user.name
    // <victim-login>` would otherwise let a foreign commit impersonate the PR author whenever
    // GitHub cannot resolve a verified account). Unresolved → null, which stage0 treats as foreign.
    commitAuthors: commits.map((c) => c.author?.login ?? null),
    prAuthor: pr.user?.login ?? "",
    // forcePushed corroboration: honor the webhook's forced flag, and independently detect a
    // rewritten history via the compare status ("diverged"/"behind" ⇒ headSha no longer
    // contains approvedSha). Either signal alone is sufficient to treat the branch as rewritten.
    forcePushed: opts.webhookForced || firstStatus === "diverged" || firstStatus === "behind",
    baseChanged: commits.length === 0 && files.length === 0,
    patchByFile: Object.fromEntries(files.map((f) => [f.filename, f.patch ?? ""])),
    blobSource: { octokit, owner, repo },
  };
}

/** File-level fingerprint of one side of a comparison: path + exact line counts. */
type OwnDelta = Map<string, string>;

function fingerprint(files: any[]): OwnDelta {
  const m: OwnDelta = new Map();
  for (const f of files) {
    // status + line counts + the patch body with hunk HEADERS stripped. Hunk headers carry
    // absolute line numbers, which legitimately shift when unrelated base-branch edits land
    // above the PR's own hunks; the payload lines (+/-/context) do not. Comparing the stripped
    // body is therefore precise about content while tolerant of position — and any conflict
    // resolution that actually edited the PR's proposal changes the payload, not just offsets.
    const body = String(f.patch ?? "")
      .split("\n")
      .filter((l: string) => !l.startsWith("@@"))
      .join("\n");
    m.set(f.filename, `${f.status}:${f.additions}:${f.deletions}:${body}`);
  }
  return m;
}

function sameOwnDelta(a: OwnDelta, b: OwnDelta): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Detects the "Update branch" / merge-base-only case: head is a merge commit that pulled the
 * base branch into the PR and changed NOTHING about the PR's own proposal.
 *
 * The predicate is deliberately narrow — every clause must hold:
 *   1. head is a merge commit with exactly two parents;
 *   2. its FIRST parent is exactly the approved SHA (so no PR-authored commit landed alongside
 *      the merge — if the developer also pushed real work, parent[0] is that commit, not the
 *      approved one, and we fall through to the normal foreign-author/size/denylist path);
 *   3. the PR's own delta measured against the merged-in base (parent[1] → head) is byte-for-byte
 *      the same set of files, statuses, line counts and patch bodies as the PR's own delta at
 *      approval time (parent[1] ... approvedSha, three-dot, i.e. what the PR proposed relative to
 *      that same base).
 *
 * Clause 3 is what makes this safe rather than a hole in the identity contract: a merge whose
 * conflict resolution edited any file the PR touches — the only way to smuggle unreviewed content
 * in through a merge commit — produces a different own-delta and returns false, so the change is
 * evaluated normally and dismissed as a foreign-author content change. Anything this returns true
 * for contains, by construction, zero proposed content that a human has not already approved on
 * this PR or merged into the base branch through its own review.
 *
 * Any API failure returns false (evaluate normally = the stricter path). Fail closed.
 */
async function detectUpdateBranchMerge(
  octokit: Octokit, owner: string, repo: string, approvedSha: string, headSha: string,
): Promise<boolean> {
  try {
    const head = await withRateLimit(() => octokit.repos.getCommit({ owner, repo, ref: headSha }));
    const parents = (head.data.parents ?? []).map((p: any) => p.sha);
    if (parents.length !== 2) return false;
    if (parents[0] !== approvedSha) return false;

    const baseSide = parents[1];
    const [now, atApproval] = await Promise.all([
      withRateLimit(() => octokit.repos.compareCommitsWithBasehead({
        owner, repo, basehead: `${baseSide}...${headSha}`, per_page: 100,
      })),
      withRateLimit(() => octokit.repos.compareCommitsWithBasehead({
        owner, repo, basehead: `${baseSide}...${approvedSha}`, per_page: 100,
      })),
    ]);

    // Bail out rather than guess if either side is paginated beyond the first page: an
    // incomplete file list could make two different deltas look equal. Fail closed.
    const complete = (r: any) => (r.data.files?.length ?? 0) < 100;
    if (!complete(now) || !complete(atApproval)) return false;

    return sameOwnDelta(fingerprint(now.data.files ?? []), fingerprint(atApproval.data.files ?? []));
  } catch {
    return false; // any uncertainty → evaluate normally (stricter)
  }
}
