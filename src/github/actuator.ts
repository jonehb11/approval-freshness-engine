import { Octokit } from "@octokit/rest";
import { Action, Decision } from "../stages/types.js";
import { auditDecision } from "../audit/logger.js";

// The ONLY component that writes to GitHub. By construction it can:
//   - set the check-run result
//   - dismiss a review + comment + request re-review
// It has NO code path that submits an approving review. (Enforced by test: grep for
// createReview({event:'APPROVE'}) must find nothing.)
export interface ActuationContext {
  octokit: Octokit;
  owner: string; repo: string;
  prNumber: number; headSha: string;
  reviewIds: number[];       // current approving reviews to dismiss on DISMISS
  approverLogins: string[];  // to request re-review from on DISMISS
  dryRun: boolean;           // shadow mode: log only, no writes
}

const CHECK_NAME = "approval-freshness/evaluated";

export async function actuate(decision: Decision, ctx: ActuationContext): Promise<void> {
  // 1. Always write the audit event FIRST (write-ahead of any side effect).
  await auditDecision(decision, ctx);

  if (ctx.dryRun) return; // shadow mode: decision logged, no GitHub mutation

  if (decision.action === Action.PRESERVE) {
    await setCheck(ctx, "success",
      "Approval preserved: change is semantically null / low-impact.", decision);
    await comment(ctx, renderPreserveComment(decision));
    return;
  }

  // DISMISS: block the merge (check red), dismiss stale review(s), request re-review.
  await setCheck(ctx, "failure",
    "Approval dismissed: substantive change since review; human re-review required.", decision);
  for (const reviewId of ctx.reviewIds) {
    await ctx.octokit.pulls.dismissReview({
      owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber,
      review_id: reviewId,
      message: `Approval-freshness engine: ${decision.reason} — ${decision.detail}`,
    });
  }
  if (ctx.approverLogins.length) {
    await ctx.octokit.pulls.requestReviewers({
      owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber,
      reviewers: ctx.approverLogins,
    }).catch(() => {/* non-fatal: reviewer may be unavailable */});
  }
  await comment(ctx, renderDismissComment(decision));
}

async function setCheck(ctx: ActuationContext, conclusion: "success" | "failure", summary: string, d: Decision) {
  await ctx.octokit.checks.create({
    owner: ctx.owner, repo: ctx.repo, name: CHECK_NAME, head_sha: ctx.headSha,
    status: "completed", conclusion,
    output: { title: CHECK_NAME, summary, text: "```json\n" + JSON.stringify(d, null, 2) + "\n```" },
  });
}

async function comment(ctx: ActuationContext, body: string) {
  await ctx.octokit.issues.createComment({
    owner: ctx.owner, repo: ctx.repo, issue_number: ctx.prNumber, body,
  });
}

function renderPreserveComment(d: Decision): string {
  return [
    `### ✅ Approval preserved`,
    ``,
    `No re-review needed. The change since the last approval was **${d.reason.replace(/_/g, " ")}**.`,
    ``,
    `> ${d.detail}`,
    ``,
    d.evidence ? `<details><summary>Evidence</summary>\n\n\`\`\`json\n${JSON.stringify(d.evidence, null, 2)}\n\`\`\`\n</details>` : "",
    ``,
    `_Determined by the approval-freshness engine. Every decision is logged. This is not a machine approval — your existing human approval stands._`,
  ].join("\n");
}

function renderDismissComment(d: Decision): string {
  return [
    `### 🔄 Re-review required`,
    ``,
    `The approval was dismissed because the change since review is **${d.reason.replace(/_/g, " ")}**.`,
    ``,
    `> ${d.detail}`,
    ``,
    `Here is exactly what changed since the last approval — you don't need to re-read the whole PR:`,
    d.evidence ? `\n<details><summary>What changed</summary>\n\n\`\`\`json\n${JSON.stringify(d.evidence, null, 2)}\n\`\`\`\n</details>` : "",
  ].join("\n");
}
