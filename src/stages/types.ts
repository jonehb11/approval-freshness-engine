// Core decision types. The ENTIRE action space of this engine is here:
// it can DISMISS or PRESERVE. There is intentionally no APPROVE.
export enum Action {
  DISMISS = "dismiss",   // dismiss the stale human approval; merge blocked until re-review
  PRESERVE = "preserve", // leave the human approval intact; take no action on the review
}

export type ReasonCode =
  | "denylist_path"
  | "force_push"
  // The head is a MERGE commit whose result differs from what a clean merge of its two parents
  // would have produced — i.e. conflicts were resolved by hand. That resolution is new code no
  // one reviewed, and it can DISCARD changes from the base branch invisibly.
  | "merge_conflict_resolution"
  | "foreign_author_commit"
  | "codeowners_path"
  | "injection_canary"
  // A changed line carried a DIRECTIVE comment — lint suppression, build constraint, type-check
  // suppression. Inert-looking, but it changes what the compiler/linter/type checker does.
  | "directive_comment"
  | "hard_size_cap"
  | "ast_identical"
  // No semantic change other than COMMENTS, and none of the changed comments carried a
  // directive (see cfg.directiveCommentPatterns). Distinct from ast_identical because it is a
  // materially different claim: "nothing changed" vs "only inert prose changed".
  | "comment_only"
  | "trivial_class"
  | "merge_base_only"
  | "model_low_impact_gated"
  | "model_high_impact"
  | "model_low_confidence"
  | "corroboration_gate_failed"
  | "model_error"
  | "unresolved_approved_sha"
  | "unsupported_language_fallthrough"
  | "self_governance"
  // Stage 2 was not consulted because the deployment runs deterministic-only
  // (cfg.stage2Enabled === false). Everything Stage 1 cannot prove null dismisses to human
  // re-review — the strictest posture, and the one rollout phase P2 runs under.
  | "deterministic_only_mode"
  | "stage2_unexpected_error";

export interface Decision {
  action: Action;
  stage: 0 | 1 | 2;
  reason: ReasonCode;
  detail: string;
  evidence?: Record<string, unknown>; // difftastic report, model verdict, gate results
}

export interface Delta {
  repo: string;             // "owner/name" of the repo under evaluation (for self-governance gate)
  approvedSha: string;
  headSha: string;
  changedFiles: string[];
  addedLines: number;
  removedLines: number;
  commitAuthors: (string | null)[];  // GitHub-verified logins of commit authors in (approvedSha..headSha]; null = GitHub could not resolve a verified account and is treated as FOREIGN
  prAuthor: string;
  forcePushed: boolean;
  baseChanged: boolean;
  patchByFile: Record<string, string>; // unified diff text per file (for difftastic + model)
  /**
   * Optional handle Stage 1 uses to materialize the two blob versions difftastic compares.
   * Deliberately OPTIONAL and deliberately not part of the decision inputs: when it is absent
   * (every unit test constructs a Delta without it), materializeBlobs throws, stage 1 maps the
   * throw to "unsupported", and the evaluation fails CLOSED — no preserve. Only the live wiring
   * in buildDelta() populates it.
   */
  /**
   * True when the head is a merge commit whose outcome is NOT what a clean merge of its parents
   * would produce — conflicts were resolved by hand. Set by buildDelta, dismissed categorically
   * by stage 0.
   *
   * This cannot be inferred from the approved→head diff, which is exactly why it is carried as a
   * flag: a conflict resolution that DISCARDS a change from the base branch leaves the PR's own
   * files identical to what was approved, so the diff the engine would otherwise reason about
   * shows nothing at all.
   */
  mergeAlteredProposal?: boolean;
  /**
   * Set when the merge altered the proposal but the base-side comparison could not be obtained,
   * so no truthful delta exists to judge. Stage 0 dismisses categorically in that case — a
   * resolution nobody can inspect is not one a classifier should be asked to bless.
   */
  mergeDeltaUnavailable?: boolean;
  blobSource?: {
    octokit: any;
    owner: string;
    repo: string;
  };
}

/**
 * Creates a DISMISS decision.
 * Fail-Closed Invariant: This is the default, safe fallback action. By creating a DISMISS,
 * the system requires a human re-review, ensuring no unverified code is merged.
 *
 * @param stage - The stage number (0, 1, or 2) making the decision.
 * @param reason - The specific reason code for dismissal.
 * @param detail - A human-readable explanation of the dismissal.
 * @param evidence - Optional JSON-serializable evidence for the audit log.
 * @returns A decision object representing a DISMISS action.
 */
export const dismiss = (stage: 0 | 1 | 2, reason: ReasonCode, detail: string, evidence?: Record<string, unknown>): Decision =>
  ({ action: Action.DISMISS, stage, reason, detail, evidence });

/**
 * Creates a PRESERVE decision.
 * Fail-Closed Invariant: This is only permitted when rigorous, deterministic proofs
 * or multi-gated AI corroboration conclusively show the change is safe. If any doubt exists,
 * the system must call dismiss() instead.
 *
 * @param stage - The stage number (0, 1, or 2) making the decision.
 * @param reason - The specific reason code for preservation.
 * @param detail - A human-readable explanation of the preservation.
 * @param evidence - Optional JSON-serializable evidence for the audit log.
 * @returns A decision object representing a PRESERVE action.
 */
export const preserve = (stage: 0 | 1 | 2, reason: ReasonCode, detail: string, evidence?: Record<string, unknown>): Decision =>
  ({ action: Action.PRESERVE, stage, reason, detail, evidence });
