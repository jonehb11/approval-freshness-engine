import { Octokit } from "@octokit/rest";
import { setCheckSuccessForFreshApproval } from "./actuator.js";

// The fresh-approval echo: the engine's PRIMARY recovery/unblock path now that there is no
// dead-man switch and no ruleset-write credential anywhere in the system (see README.md
// "End-to-End Flow & Fail-Safe Mechanics"). A fresh, platform-verified human approval submitted against the
// EXACT current head SHA is, by GitHub's own construction, the re-review this check exists to
// require. Echoing that fact to a check success is not a machine approval and involves no AI
// or heuristic judgment whatsoever — it is a deterministic relay of something GitHub itself
// already verified (review.commit_id is set server-side, and GitHub platform-blocks
// self-approval independent of anything this file does).
//
// This module is split into a PURE decision function (evaluateFreshApproval) and a
// side-effecting handler (handleFreshApproval) so the decision logic is fully table-testable
// without mocking the GitHub API — see test/fresh_approval.test.ts.

/**
 * Every possible outcome of evaluating a pull_request_review "submitted" event for the
 * fresh-approval echo, each with a distinct, audit-loggable reason code. Precondition checks
 * are deliberately NOT collapsed into one boolean: a distinct reason per failure mode is what
 * makes the audit trail (and this table-driven test suite) actually diagnostic.
 */
export type FreshApprovalReason =
  | "qualified"
  | "malformed_payload"
  | "review_not_approved"
  | "missing_commit_id"
  | "stale_commit_id"
  | "self_approval"
  | "bot_reviewer"
  | "pr_draft"
  | "pr_not_open";

export interface FreshApprovalResult {
  qualify: boolean;
  reason: FreshApprovalReason;
}

/**
 * Pure decision function: does this pull_request_review "submitted" payload constitute a
 * fresh human approval on the exact current head SHA?
 * Fail-Closed Invariant: EVERY precondition below is required (logical AND). Any failure —
 * including malformed/missing fields — returns qualify:false. A qualify:false result is NEVER
 * treated as evidence of staleness by the caller; it is simply a no-op (see handleFreshApproval
 * doc comment). This function has no side effects and throws nothing: an unparseable payload
 * degrades to `{ qualify: false, reason: "malformed_payload" }` rather than throwing, so a
 * webhook processor never crashes evaluating attacker-influenced JSON shape.
 *
 * @param payload - The pull_request_review webhook payload (action === "submitted").
 * @returns Whether the review qualifies for the echo, and why (or why not).
 */
export function evaluateFreshApproval(payload: any): FreshApprovalResult {
  const review = payload?.review;
  const pr = payload?.pull_request;

  // Defensive shape check first: a webhook payload is attacker-adjacent input (it's whatever
  // GitHub relays, but signature verification only proves it came from GitHub, not that it has
  // the shape we expect for this event type). Fail closed on anything unexpected.
  if (
    !review || typeof review !== "object" ||
    !pr || typeof pr !== "object" ||
    !review.user || typeof review.user !== "object" ||
    !pr.user || typeof pr.user !== "object"
  ) {
    return { qualify: false, reason: "malformed_payload" };
  }

  // Precondition 1 — review.state === "approved".
  // Case-insensitive per GitHub payload variance: the platform's REST
  // API renders review state as uppercase ("APPROVED") while webhook payloads render it
  // lowercase ("approved"); tolerating case here is safe because this is a closed enum
  // (approved/changes_requested/commented/dismissed), not a security-bearing opaque identifier.
  // Contrast with the commit_id check below, which is intentionally NOT case-folded.
  if (typeof review.state !== "string" || review.state.toLowerCase() !== "approved") {
    return { qualify: false, reason: "review_not_approved" };
  }

  // Precondition 2 — review.commit_id === pull_request.head.sha, EXACT string equality.
  // A SHA is an opaque identifier, not a display string: fail-closed means we never fold case
  // or otherwise normalize it. An approval submitted against any commit other than literally
  // the current head — including a stale prior head — does not qualify. This is what makes the
  // echo a genuine "re-review", not a rubber stamp: pushing new commits invalidates it.
  if (review.commit_id === null || review.commit_id === undefined || review.commit_id === "") {
    return { qualify: false, reason: "missing_commit_id" };
  }
  if (typeof pr.head?.sha !== "string" || review.commit_id !== pr.head.sha) {
    return { qualify: false, reason: "stale_commit_id" };
  }

  // Precondition 3 — defense in depth against self-approval (the platform already
  // blocks this natively). We re-check anyway: trusting a single enforcement point for a
  // security invariant is exactly the class of single-point-of-failure this engine exists to
  // avoid, and the check is nearly free.
  if (review.user.login === pr.user.login) {
    return { qualify: false, reason: "self_approval" };
  }

  // Precondition 4 — reviewer must be a human identity, not a bot. An automated "approval" —
  // even one that is otherwise state/commit_id/author valid — is not the human re-review this
  // echo is meant to relay.
  if (review.user.type === "Bot") {
    return { qualify: false, reason: "bot_reviewer" };
  }

  // Precondition 5 — the PR itself must be open and not a draft. Draft PRs cannot be merged,
  // so an "approval" on one is not gating anything the ruleset would otherwise block; a closed
  // PR's approval is stale by definition (there is no live head to be fresh against).
  if (pr.draft === true) {
    return { qualify: false, reason: "pr_draft" };
  }
  if (pr.state !== "open") {
    return { qualify: false, reason: "pr_not_open" };
  }

  return { qualify: true, reason: "qualified" };
}

export interface FreshApprovalContext {
  octokit: Octokit;
  owner: string;
  repo: string;
  dryRun: boolean; // shadow mode: log only, no writes (mirrors ActuationContext.dryRun)
}

/**
 * Side-effecting handler for a pull_request_review "submitted" webhook: evaluates the payload
 * with the pure decision function, writes an audit record write-ahead of any GitHub mutation
 * (mirroring the discipline in src/audit/logger.ts::auditDecision — the record exists even if
 * the subsequent actuation call fails or the process crashes), and — only on qualify — calls
 * the actuator to echo the fresh approval as a check success.
 * Fail-Closed Invariant: A non-qualifying review NEVER sets check failure and never dismisses
 * anything. It is a pure no-op. A review that doesn't meet the bar is not evidence the approval
 * is stale — it is simply not a fresh-approval event, so the check is left exactly as the
 * DISMISS/PRESERVE ladder last set it (or as GitHub's default "no check" state, which already
 * blocks merge — required checks are matched per head SHA). This handler contains no path that creates or submits a review — its
 * entire GitHub write surface is a single check-run success write, delegated to the actuator.
 *
 * @param payload - The pull_request_review webhook payload (action === "submitted").
 * @param ctx - The FreshApprovalContext (GitHub client + repo coordinates + shadow-mode flag).
 */
export async function handleFreshApproval(payload: any, ctx: FreshApprovalContext): Promise<void> {
  const result = evaluateFreshApproval(payload);

  const headSha: string | null = payload?.pull_request?.head?.sha ?? null;
  const reviewer: string | null = payload?.review?.user?.login ?? null;
  const prNumber: number | null = payload?.pull_request?.number ?? null;

  // Audit write-ahead: log BEFORE any GitHub mutation, so a record of the evaluation survives
  // even if the actuator call below throws or the process is killed mid-flight. Same
  // structured-JSON-to-stdout discipline as src/audit/logger.ts::auditDecision.
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    kind: "fresh_approval_echo",
    repo: `${ctx.owner}/${ctx.repo}`,
    pr: prNumber,
    headSha,
    reviewer,
    qualify: result.qualify,
    reason: result.reason,
    dryRun: ctx.dryRun,
  }));

  if (!result.qualify) return; // no-op: see Fail-Closed Invariant above.

  // result.qualify === true guarantees headSha and reviewer are non-null strings, because
  // evaluateFreshApproval only returns "qualified" after validating both fields' shapes.
  await setCheckSuccessForFreshApproval(
    { octokit: ctx.octokit, owner: ctx.owner, repo: ctx.repo, headSha: headSha as string, dryRun: ctx.dryRun },
    reviewer as string,
    headSha as string,
  );
}
