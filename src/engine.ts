import { Octokit } from "@octokit/rest";
import { EngineConfig, loadConfig } from "./config/schema.js";
import { buildDelta } from "./github/pr.js";
import { evaluate } from "./stages/ladder.js";
import { actuate, setCheckPending, CHECK_NAME } from "./github/actuator.js";
import { withRateLimit } from "./github/client.js";
import { Action } from "./stages/types.js";

/**
 * The evaluation entry point shared by every host: the long-running HTTP server
 * (src/index.ts) and the Lambda adapter (deploy/lambda/handler.ts) both call
 * evaluateSynchronize(). Keeping it here — rather than inside either host — is what lets the two
 * deployments run byte-identical decision logic instead of drifting into two implementations of
 * "the ladder, roughly".
 *
 * Fail-closed contract for everything below: a thrown error leaves the required check in
 * whatever non-passing state it already had (missing, or the in_progress marker), which GitHub's
 * ruleset treats exactly like a failure — merge blocked. No error path writes success.
 */

let cachedConfig: EngineConfig | undefined;

/**
 * Loads and caches the validated config for the process lifetime (a Lambda execution
 * environment, or a pod). A config that fails validation THROWS on every call rather than being
 * cached as broken — the engine never evaluates against a config it could not fully validate.
 */
export async function getConfig(): Promise<EngineConfig> {
  if (!cachedConfig) cachedConfig = await loadConfig();
  return cachedConfig;
}

/** Test hook: forget the cached config so cases can vary AFE_CONFIG_PATH. */
export function __resetConfigCacheForTest(): void {
  cachedConfig = undefined;
}

export interface SynchronizeInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  /** The `forced` flag from a push event when available; the pull_request path passes false. */
  webhookForced?: boolean;
  dryRun: boolean;
  /** Structured-log correlation id (X-GitHub-Delivery). */
  deliveryId: string;
}

export interface SynchronizeOutcome {
  /** What the engine did — for logs, metrics and tests. */
  outcome: "preserved" | "dismissed" | "no_approval" | "not_evaluated";
  reason?: string;
}

/**
 * Resolves the SHA the newest still-standing human approval was submitted against.
 *
 * Returns undefined when there is no approval to preserve — an unapproved PR has nothing stale
 * about it, so the engine takes no action at all and the check simply stays non-passing until a
 * human approves (at which point the fresh-approval echo greens it). Dismissed reviews are
 * excluded: GitHub reports them with state "DISMISSED", and resurrecting one would invent an
 * approval nobody currently stands behind.
 */
async function resolveApprovals(
  octokit: Octokit, owner: string, repo: string, prNumber: number, prAuthor: string,
): Promise<{ approvedSha?: string; reviewIds: number[]; approverLogins: string[] }> {
  const reviews = await withRateLimit(() => octokit.pulls.listReviews({
    owner, repo, pull_number: prNumber, per_page: 100,
  }));
  let approvedSha: string | undefined;
  const reviewIds: number[] = [];
  const approverLogins: string[] = [];
  for (const r of reviews.data) {
    // Iterating in API order (chronological) and overwriting keeps the LAST approval, which is
    // the one whose staleness we are judging.
    if (r.state !== "APPROVED") continue;
    // Defense in depth against a self-approval that somehow exists (GitHub platform-blocks it):
    // an approval by the PR author is not a human review of the author's own work.
    if (r.user?.login && r.user.login === prAuthor) continue;
    if (r.commit_id) approvedSha = r.commit_id;
    reviewIds.push(r.id);
    if (r.user?.login) approverLogins.push(r.user.login);
  }
  return { approvedSha, reviewIds, approverLogins: [...new Set(approverLogins)] };
}

/**
 * The full post-approval evaluation: resolve what was approved, build the delta, run the ladder,
 * actuate. Called for pull_request "synchronize" (a push onto an open PR).
 */
export async function evaluateSynchronize(input: SynchronizeInput): Promise<SynchronizeOutcome> {
  const { octokit, owner, repo, prNumber, headSha, dryRun, deliveryId } = input;
  const log = (msg: string) => console.log(`[${deliveryId}] ${owner}/${repo}#${prNumber} ${msg}`);

  const cfg = await getConfig();

  const pr = await withRateLimit(() => octokit.pulls.get({ owner, repo, pull_number: prNumber }));
  if (pr.data.state !== "open") {
    log("PR is not open; skipping evaluation.");
    return { outcome: "not_evaluated", reason: "pr_not_open" };
  }

  const prAuthor = pr.data.user?.login ?? "";
  const { approvedSha, reviewIds, approverLogins } = await resolveApprovals(octokit, owner, repo, prNumber, prAuthor);

  if (!approvedSha) {
    // Nothing approved yet: there is no stale approval to preserve or dismiss, and writing
    // `failure` here would be noise (the merge is already blocked by the missing approval AND by
    // the non-passing check). Leave the in_progress marker standing — a first approval on this
    // head is what turns it green, via the echo.
    log("no standing approval; leaving the check pending for a first human approval.");
    return { outcome: "no_approval" };
  }

  // The delta the whole decision rests on. A throw here propagates to the caller, which logs and
  // writes nothing — the check stays non-passing.
  const delta = await buildDelta(octokit, owner, repo, pr.data, approvedSha, headSha, {
    webhookForced: input.webhookForced ?? false,
  });

  // The inputs the verdict is computed from. Logged before the verdict so an audit can replay
  // the reasoning, and so "why did this dismiss?" is answerable without re-deriving the delta.
  log(`delta approved=${delta.approvedSha.slice(0, 8)} head=${delta.headSha.slice(0, 8)} files=${delta.changedFiles.length} [${delta.changedFiles.slice(0, 10).join(", ")}] +${delta.addedLines}/-${delta.removedLines} authors=[${delta.commitAuthors.join(", ")}] prAuthor=${delta.prAuthor} forced=${delta.forcePushed} baseChanged=${delta.baseChanged}`);

  const decision = await evaluate(delta, cfg);
  log(`decision=${decision.action} stage=${decision.stage} reason=${decision.reason} :: ${decision.detail}`);

  await actuate(decision, {
    octokit, owner, repo, prNumber, headSha,
    reviewIds, approverLogins, dryRun,
  });

  return {
    outcome: decision.action === Action.PRESERVE ? "preserved" : "dismissed",
    reason: decision.reason,
  };
}

/**
 * Publishes the non-passing in_progress marker for a head SHA, with a summary honest about
 * which lifecycle moment produced it. Never satisfies the required check (in_progress is not a
 * completed conclusion), so this is purely developer-visible state.
 */
export async function publishPendingCheck(args: {
  octokit: Octokit; owner: string; repo: string; headSha: string; dryRun: boolean; action: string;
}): Promise<void> {
  const { octokit, owner, repo, headSha, dryRun, action } = args;

  // Clobber guard. "reopened" and "ready_for_review" fire on a head SHA that is USUALLY
  // UNCHANGED, and that SHA may already carry a completed `success` from one of the two
  // legitimate producers (a PRESERVE verdict, or the fresh-approval echo). Writing a new
  // in_progress run would supersede that success with a state nothing is wired to complete —
  // silently re-blocking a PR whose approval never changed, on a commit nobody touched.
  //
  // Safety is unaffected in every direction: skipping a write can never satisfy anything; a
  // spoofed same-named success from a foreign App would at most suppress this cosmetic write
  // (the integration_id pin still rejects it as a gate); and if the read itself fails the throw
  // propagates and no pending is written. "synchronize" skips the read — a brand-new head SHA
  // cannot already carry an approval-derived success.
  //
  // This lives HERE rather than in either host because both the server and the Lambda adapter
  // call it: a guard implemented in only one host is a guard that silently does not exist in
  // production (which is exactly how it was first shipped, and how live testing caught it).
  if (action !== "synchronize" && !dryRun) {
    const existing = await withRateLimit(() => octokit.checks.listForRef({
      owner, repo, ref: headSha, check_name: CHECK_NAME, per_page: 100,
    }));
    const alreadySucceeded = (existing.data.check_runs ?? []).some(
      (r) => r.status === "completed" && r.conclusion === "success",
    );
    if (alreadySucceeded) {
      console.log(`${owner}/${repo}@${headSha.slice(0, 8)} already carries a completed success; leaving it intact (action=${action}).`);
      return;
    }
  }

  const summary = action === "synchronize"
    ? undefined
    : "Waiting for a human approval on this pull request's current head commit. A fresh approval on the exact head SHA turns this check green.";
  await setCheckPending({ octokit, owner, repo, headSha, dryRun }, summary);
}

export { CHECK_NAME };
