// Core decision types. The ENTIRE action space of this engine is here:
// it can DISMISS or PRESERVE. There is intentionally no APPROVE.
export enum Action {
  DISMISS = "dismiss",   // dismiss the stale human approval; merge blocked until re-review
  PRESERVE = "preserve", // leave the human approval intact; take no action on the review
}

export type ReasonCode =
  | "denylist_path"
  | "force_push"
  | "foreign_author_commit"
  | "codeowners_path"
  | "injection_canary"
  | "hard_size_cap"
  | "ast_identical"
  | "trivial_class"
  | "merge_base_only"
  | "model_low_impact_gated"
  | "model_high_impact"
  | "model_low_confidence"
  | "corroboration_gate_failed"
  | "model_error"
  | "unresolved_approved_sha"
  | "unsupported_language_fallthrough";

export interface Decision {
  action: Action;
  stage: 0 | 1 | 2;
  reason: ReasonCode;
  detail: string;
  evidence?: Record<string, unknown>; // difftastic report, model verdict, gate results
}

export interface Delta {
  approvedSha: string;
  headSha: string;
  changedFiles: string[];
  addedLines: number;
  removedLines: number;
  commitAuthors: string[];  // logins of commit authors in (approvedSha..headSha]
  prAuthor: string;
  forcePushed: boolean;
  baseChanged: boolean;
  patchByFile: Record<string, string>; // unified diff text per file (for difftastic + model)
}

export const dismiss = (stage: 0 | 1 | 2, reason: ReasonCode, detail: string, evidence?: Record<string, unknown>): Decision =>
  ({ action: Action.DISMISS, stage, reason, detail, evidence });

export const preserve = (stage: 0 | 1 | 2, reason: ReasonCode, detail: string, evidence?: Record<string, unknown>): Decision =>
  ({ action: Action.PRESERVE, stage, reason, detail, evidence });
