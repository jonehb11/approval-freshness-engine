import { Decision } from "../stages/types.js";
import { PROMPT_VERSION } from "../model/prompt.js";

// Immutable, append-only structured audit event → stdout (scraped to Loki audit tenant,
// 6-year retention). No delete path exists anywhere in the engine.
/**
 * Logs a structured audit event to stdout for ingestion.
 * Fail-Closed Invariant: Audit logging occurs before any GitHub side-effects. This ensures
 * that a record of the decision is immutably written even if downstream actuation fails,
 * providing transparency into all engine actions.
 *
 * @param decision - The final Decision made by the engine.
 * @param ctx - The metadata and context of the actuation.
 */
export async function auditDecision(decision: Decision, ctx: {
  owner: string; repo: string; prNumber: number; headSha: string;
  reviewIds: number[]; approverLogins: string[]; dryRun: boolean;
}): Promise<void> {
  const event = {
    ts: new Date().toISOString(),
    kind: "approval_freshness_decision",
    repo: `${ctx.owner}/${ctx.repo}`,
    pr: ctx.prNumber,
    headSha: ctx.headSha,
    action: decision.action,
    stage: decision.stage,
    reason: decision.reason,
    detail: decision.detail,
    approvers: ctx.approverLogins,
    dismissedReviewIds: decision.action === "dismiss" ? ctx.reviewIds : [],
    promptVersion: PROMPT_VERSION,
    dryRun: ctx.dryRun,
    evidence: decision.evidence ?? null,
  };
  // Structured line; the platform's log pipeline routes kind=approval_freshness_decision
  // to the audit tenant. Never console.log secrets — this event contains none by design.
  console.log(JSON.stringify(event));
}
