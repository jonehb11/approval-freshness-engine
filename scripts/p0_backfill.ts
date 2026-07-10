/**
 * P0 EVIDENCE SPIKE — READ ONLY. Grants NO write scopes. Takes NO action.
 *
 * Walks the last N days of merged/closed PRs across enrolled candidate repos,
 * reconstructs every post-approval push, and classifies what WOULD have happened
 * under Stages 0 and 1 (deterministic only — no model spend in P0).
 *
 * OUTPUT: the number that wins the security meeting —
 *   "X% of approval dismissals in the last quarter were semantically null,
 *    of which Y% were merge-base-only (an unrelated PR moving the base)."
 *
 * Run: MODE=readonly ts-node scripts/p0_backfill.ts --days 90 --repos org/a,org/b
 */
import { Octokit } from "@octokit/rest";
import { loadConfig } from "../src/config/schema.js";
import { stage0 } from "../src/stages/stage0_hardrules.js";
import { stage1 } from "../src/stages/stage1_difftastic.js";
import { buildDelta } from "../src/github/pr.js";
import { Action } from "../src/stages/types.js";

interface Tally {
  totalPostApprovalPushes: number;
  wouldDismissStage0: number;
  wouldPreserveStage1: number;   // <-- semantically null: the savings
  ofWhichMergeBaseOnly: number;
  ofWhichAstIdentical: number;
  ofWhichTrivialClass: number;
  fallThroughToStage2: number;   // would need the model (not run in P0)
}

async function main() {
  const cfg = await loadConfig();
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN }); // read-only PAT/app token
  const days = Number(argv("--days") ?? 90);
  const repos = (argv("--repos") ?? "").split(",").filter(Boolean);
  const since = new Date(Date.now() - days * 864e5).toISOString();

  const tally: Tally = {
    totalPostApprovalPushes: 0, wouldDismissStage0: 0, wouldPreserveStage1: 0,
    ofWhichMergeBaseOnly: 0, ofWhichAstIdentical: 0, ofWhichTrivialClass: 0, fallThroughToStage2: 0,
  };

  for (const full of repos) {
    const [owner, repo] = full.split("/");
    const prs = await octokit.paginate(octokit.pulls.list, {
      owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: 100,
    });
    for (const pr of prs) {
      if (new Date(pr.updated_at) < new Date(since)) continue;

      const reviews = await octokit.paginate(octokit.pulls.listReviews, {
        owner, repo, pull_number: pr.number, per_page: 100,
      });
      const approvals = reviews.filter((r) => r.state === "APPROVED");
      if (!approvals.length) continue;

      const commits = await octokit.paginate(octokit.pulls.listCommits, {
        owner, repo, pull_number: pr.number, per_page: 100,
      });
      // Find pushes that landed AFTER the earliest approval → the dismissal-triggering events.
      const firstApprovalAt = new Date(approvals[0].submitted_at!).getTime();
      const postApprovalCommits = commits.filter((c) =>
        new Date(c.commit.author?.date ?? c.commit.committer?.date ?? 0).getTime() > firstApprovalAt);
      if (!postApprovalCommits.length) continue;

      tally.totalPostApprovalPushes++;

      const delta = await buildDelta(octokit, owner, repo, pr, approvals[0].commit_id!, pr.head.sha);
      const s0 = stage0(delta, cfg);
      if (s0 && s0.action === Action.DISMISS) { tally.wouldDismissStage0++; continue; }
      const s1 = await stage1(delta, cfg);
      if (s1 && s1.action === Action.PRESERVE) {
        tally.wouldPreserveStage1++;
        if (s1.reason === "merge_base_only") tally.ofWhichMergeBaseOnly++;
        if (s1.reason === "ast_identical") tally.ofWhichAstIdentical++;
        if (s1.reason === "trivial_class") tally.ofWhichTrivialClass++;
        continue;
      }
      tally.fallThroughToStage2++;
    }
  }

  const pct = (n: number) => tally.totalPostApprovalPushes
    ? ((100 * n) / tally.totalPostApprovalPushes).toFixed(1) : "0";
  console.log(JSON.stringify(tally, null, 2));
  console.log(`\n=== THE NUMBER ===`);
  console.log(`${pct(tally.wouldPreserveStage1)}% of post-approval pushes were SEMANTICALLY NULL`);
  console.log(`  (deterministically preservable with ZERO AI involvement)`);
  console.log(`${pct(tally.ofWhichMergeBaseOnly)}% were merge-base-only (unrelated PR moved the base)`);
  console.log(`${pct(tally.fallThroughToStage2)}% would need the AI classifier (Stage 2)`);
  console.log(`${pct(tally.wouldDismissStage0)}% correctly hit a hard rule → always human review`);
}

function argv(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
main().catch((e) => { console.error(e); process.exit(1); });
