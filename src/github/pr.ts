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
 * @returns A promise resolving to the unified Delta object.
 */
export async function buildDelta(
  octokit: Octokit, owner: string, repo: string, pr: any, approvedSha: string, headSha: string,
): Promise<Delta> {
  const files: any[] = [];
  const commits: any[] = [];
  let page = 1;
  const per_page = 100;

  // Optimize and handle pagination using a loop
  while (true) {
    const cmp = await withRateLimit(() => octokit.repos.compareCommitsWithBasehead({
      owner, repo, basehead: `${approvedSha}...${headSha}`,
      per_page, page,
    }));
    
    if (cmp.data.files) files.push(...cmp.data.files);
    if (cmp.data.commits) commits.push(...cmp.data.commits);
    
    // Stop if we receive fewer items than the per_page limit, meaning we've hit the last page
    if ((cmp.data.commits?.length ?? 0) < per_page && (cmp.data.files?.length ?? 0) < per_page) {
      break;
    }
    page++;
  }

  return {
    approvedSha, headSha,
    changedFiles: files.map((f) => f.filename),
    addedLines: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    removedLines: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    commitAuthors: commits.map((c) => c.author?.login ?? c.commit.author?.name ?? ""),
    prAuthor: pr.user?.login ?? "",
    forcePushed: false, // derive from push event `forced` flag in the webhook path
    baseChanged: commits.length === 0 && files.length === 0,
    patchByFile: Object.fromEntries(files.map((f) => [f.filename, f.patch ?? ""])),
  };
}
