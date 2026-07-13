import { Octokit } from "@octokit/rest";
import { Action, Decision } from "../stages/types.js";
import { auditDecision } from "../audit/logger.js";

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

// The ONLY component that writes to GitHub. By construction it can:
//   - set the check-run result
//   - dismiss a review + comment + request re-review
// It has NO code path that submits an approving review. (Enforced by test:
// scanning for creating a review with an approve event must find nothing.)
export interface ActuationContext {
  octokit: Octokit;
  owner: string; repo: string;
  prNumber: number; headSha: string;
  reviewIds: number[];       // current approving reviews to dismiss on DISMISS
  approverLogins: string[];  // to request re-review from on DISMISS
  dryRun: boolean;           // shadow mode: log only, no writes
}

const CHECK_NAME = "approval-freshness/evaluated";

/**
 * Actuates the engine's decision by mutating GitHub state.
 * Fail-Closed Invariant: This component NEVER submits an approving review. It can only
 * preserve an existing human approval or dismiss reviews to block the merge. Any network
 * failure during actuation throws an error, leaving the GitHub state unchanged (which is
 * safely unapproved if we meant to dismiss, though a partial fail could occur, it doesn't approve).
 *
 * @param decision - The final Decision to actuate.
 * @param ctx - The ActuationContext with GitHub client and metadata.
 */
export async function actuate(decision: Decision, ctx: ActuationContext): Promise<void> {
  // 1. Always write the audit event FIRST (write-ahead of any side effect).
  await auditDecision(decision, ctx);

  if (ctx.dryRun) return; // shadow mode: decision logged, no GitHub mutation

  if (decision.action === Action.PRESERVE) {
    await Promise.all([
      setCheck(ctx, "success", "Approval preserved: change is semantically null / low-impact.", decision),
      comment(ctx, renderPreserveComment(decision))
    ]);
    return;
  }

  // DISMISS: block the merge (check red), dismiss stale review(s), request re-review.
  await setCheck(ctx, "failure", "Approval dismissed: substantive change since review; human re-review required.", decision);

  // Process dismissals sequentially to respect GitHub secondary abuse limits
  for (const reviewId of ctx.reviewIds) {
    await withRateLimit(() => ctx.octokit.pulls.dismissReview({
      owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber,
      review_id: reviewId,
      message: `Approval-freshness engine: ${decision.reason} — ${decision.detail}`,
    }));
  }

  if (ctx.approverLogins.length) {
    await withRateLimit(() => ctx.octokit.pulls.requestReviewers({
      owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber,
      reviewers: ctx.approverLogins,
    })).catch(() => {/* non-fatal: reviewer may be unavailable */});
  }

  await comment(ctx, renderDismissComment(decision));
}

/**
 * Sets the check-run result on GitHub.
 * Fail-Closed Invariant: A failure to set the check-run throws an error. The check-run itself
 * communicates the engine's stance, and setting it to failure effectively blocks PR merges.
 *
 * @param ctx - The ActuationContext.
 * @param conclusion - The check run conclusion ("success" or "failure").
 * @param summary - A summary of the check result.
 * @param d - The Decision context for the output text.
 */
async function setCheck(ctx: ActuationContext, conclusion: "success" | "failure", summary: string, d: Decision) {
  await withRateLimit(() => ctx.octokit.checks.create({
    owner: ctx.owner, repo: ctx.repo, name: CHECK_NAME, head_sha: ctx.headSha,
    status: "completed", conclusion,
    output: { title: CHECK_NAME, summary, text: "```json\n" + JSON.stringify(d, null, 2) + "\n```" },
  }));
}

/**
 * Leaves a comment on the GitHub PR.
 * Fail-Closed Invariant: If commenting fails, an error is thrown, although the primary
 * safety mechanism (dismissing the review) happens separately.
 *
 * @param ctx - The ActuationContext.
 * @param body - The body text of the comment.
 */
async function comment(ctx: ActuationContext, body: string) {
  await withRateLimit(() => ctx.octokit.issues.createComment({
    owner: ctx.owner, repo: ctx.repo, issue_number: ctx.prNumber, body,
  }));
}

/**
 * Renders the markdown comment body for a PRESERVE decision.
 * Fail-Closed Invariant: Explains clearly to humans that this is NOT a machine approval,
 * but merely preserving their existing approval due to low perceived impact.
 *
 * @param d - The PRESERVE decision.
 * @returns A formatted markdown string.
 */
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

/**
 * Renders the markdown comment body for a DISMISS decision.
 * Fail-Closed Invariant: Transparently outlines the reason for the dismissal, ensuring
 * human reviewers have the context needed for re-evaluation.
 *
 * @param d - The DISMISS decision.
 * @returns A formatted markdown string.
 */
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
