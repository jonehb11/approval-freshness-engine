import { Octokit } from "@octokit/rest";
import { Delta } from "../stages/types.js";

// Helper to handle GitHub API rate limits (primary and secondary)
// Uses exponential backoff and respects rate limit headers.
async function withRateLimit<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await action();
    } catch (e: any) {
      if (e.status === 403 && e.response?.headers) {
        const reset = e.response.headers['x-ratelimit-reset'];
        const retryAfter = e.response.headers['retry-after'];
        // Handle secondary rate limits (retry-after)
        if (retryAfter) {
          const delay = parseInt(retryAfter, 10) * 1000;
          await new Promise(r => setTimeout(r, delay));
          continue;
        } 
        // Handle primary rate limits (x-ratelimit-reset)
        else if (reset && e.response.headers['x-ratelimit-remaining'] === '0') {
          const delay = Math.max(0, parseInt(reset, 10) * 1000 - Date.now()) + 1000;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      throw e;
    }
  }
  throw new Error("GitHub API rate limit retries exhausted.");
}

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
 *   the caller. The push-event handler passes it through; the pull_request "synchronize" path
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

  return {
    repo: `${owner}/${repo}`,
    approvedSha, headSha,
    changedFiles: files.map((f) => f.filename),
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
  };
}
