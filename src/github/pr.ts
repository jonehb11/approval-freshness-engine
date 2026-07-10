import { Octokit } from "@octokit/rest";
import { Delta } from "../stages/types.js";

// Resolves the approved state and builds the Delta the ladder consumes.
// Real impl: fetch review commit_id (approvedSha), compare approvedSha..headSha,
// list changed files + per-file patch, list commit authors, detect force-push/base change.
export async function buildDelta(
  octokit: Octokit, owner: string, repo: string, pr: any, approvedSha: string, headSha: string,
): Promise<Delta> {
  const cmp = await octokit.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `${approvedSha}...${headSha}`,
  });
  const files = cmp.data.files ?? [];
  return {
    approvedSha, headSha,
    changedFiles: files.map((f) => f.filename),
    addedLines: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    removedLines: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    commitAuthors: (cmp.data.commits ?? []).map((c) => c.author?.login ?? c.commit.author?.name ?? ""),
    prAuthor: pr.user?.login ?? "",
    forcePushed: false, // derive from push event `forced` flag in the webhook path
    baseChanged: (cmp.data.commits ?? []).length === 0 && files.length === 0,
    patchByFile: Object.fromEntries(files.map((f) => [f.filename, f.patch ?? ""])),
  };
}
