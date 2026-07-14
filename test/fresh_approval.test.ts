import { describe, it, expect, vi } from "vitest";
import { evaluateFreshApproval, handleFreshApproval } from "../src/github/freshApproval.js";

const HEAD_SHA = "abc123def456abc123def456abc123def456ab0";

// Base payload representing a qualifying fresh-approval event: state approved, commit_id
// exactly equal to the PR's current head SHA, a different human reviewer, PR open & not draft.
function basePayload(overrides: {
  reviewState?: any;
  commitId?: any;
  reviewerLogin?: string;
  reviewerType?: string;
  prAuthorLogin?: string;
  headSha?: string;
  draft?: boolean;
  prState?: string;
} = {}) {
  const {
    reviewState = "approved",
    commitId = HEAD_SHA,
    reviewerLogin = "bob",
    reviewerType = "User",
    prAuthorLogin = "alice",
    headSha = HEAD_SHA,
    draft = false,
    prState = "open",
  } = overrides;

  return {
    action: "submitted",
    review: {
      state: reviewState,
      commit_id: commitId,
      user: { login: reviewerLogin, type: reviewerType },
    },
    pull_request: {
      number: 42,
      draft,
      state: prState,
      head: { sha: headSha },
      user: { login: prAuthorLogin },
    },
    repository: { owner: { login: "org" }, name: "repo" },
  };
}

describe("evaluateFreshApproval (pure decision function)", () => {
  describe("qualifying cases", () => {
    it("qualifies: approved + commit_id==head + different human reviewer + open PR", () => {
      const r = evaluateFreshApproval(basePayload());
      expect(r).toEqual({ qualify: true, reason: "qualified" });
    });

    it("qualifies: review.state case variance is tolerated (GitHub payload variance, F4)", () => {
      expect(evaluateFreshApproval(basePayload({ reviewState: "APPROVED" })).qualify).toBe(true);
      expect(evaluateFreshApproval(basePayload({ reviewState: "Approved" })).qualify).toBe(true);
    });
  });

  describe("rejecting cases — each with a distinct reason code", () => {
    it("rejects: review.state == changes_requested", () => {
      const r = evaluateFreshApproval(basePayload({ reviewState: "changes_requested" }));
      expect(r).toEqual({ qualify: false, reason: "review_not_approved" });
    });

    it("rejects: review.state == commented", () => {
      const r = evaluateFreshApproval(basePayload({ reviewState: "commented" }));
      expect(r).toEqual({ qualify: false, reason: "review_not_approved" });
    });

    it("rejects: review.state == dismissed", () => {
      const r = evaluateFreshApproval(basePayload({ reviewState: "dismissed" }));
      expect(r).toEqual({ qualify: false, reason: "review_not_approved" });
    });

    it("rejects: commit_id != head.sha (stale approval on a prior head)", () => {
      const r = evaluateFreshApproval(basePayload({ commitId: "0000000000000000000000000000000000000f" }));
      expect(r).toEqual({ qualify: false, reason: "stale_commit_id" });
    });

    it("rejects: commit_id differs from head.sha only by case (exact string equality, no case-folding of SHAs)", () => {
      const r = evaluateFreshApproval(basePayload({ commitId: HEAD_SHA.toUpperCase() }));
      expect(r).toEqual({ qualify: false, reason: "stale_commit_id" });
    });

    it("rejects: missing commit_id (null)", () => {
      const r = evaluateFreshApproval(basePayload({ commitId: null }));
      expect(r).toEqual({ qualify: false, reason: "missing_commit_id" });
    });

    it("rejects: missing commit_id (undefined)", () => {
      const payload = basePayload();
      delete (payload.review as any).commit_id;
      const r = evaluateFreshApproval(payload);
      expect(r).toEqual({ qualify: false, reason: "missing_commit_id" });
    });

    it("rejects: missing commit_id (empty string)", () => {
      const r = evaluateFreshApproval(basePayload({ commitId: "" }));
      expect(r).toEqual({ qualify: false, reason: "missing_commit_id" });
    });

    it("rejects: self-approval (reviewer login == PR author login)", () => {
      const r = evaluateFreshApproval(basePayload({ reviewerLogin: "alice", prAuthorLogin: "alice" }));
      expect(r).toEqual({ qualify: false, reason: "self_approval" });
    });

    it("rejects: Bot reviewer", () => {
      const r = evaluateFreshApproval(basePayload({ reviewerLogin: "dependabot[bot]", reviewerType: "Bot" }));
      expect(r).toEqual({ qualify: false, reason: "bot_reviewer" });
    });

    it("rejects: draft PR", () => {
      const r = evaluateFreshApproval(basePayload({ draft: true }));
      expect(r).toEqual({ qualify: false, reason: "pr_draft" });
    });

    it("rejects: closed PR", () => {
      const r = evaluateFreshApproval(basePayload({ prState: "closed" }));
      expect(r).toEqual({ qualify: false, reason: "pr_not_open" });
    });

    it("rejects: malformed payload (missing review)", () => {
      const r = evaluateFreshApproval({ pull_request: basePayload().pull_request });
      expect(r).toEqual({ qualify: false, reason: "malformed_payload" });
    });

    it("rejects: malformed payload (missing pull_request)", () => {
      const r = evaluateFreshApproval({ review: basePayload().review });
      expect(r).toEqual({ qualify: false, reason: "malformed_payload" });
    });

    it("rejects: malformed payload (review.user missing)", () => {
      const payload = basePayload();
      delete (payload.review as any).user;
      const r = evaluateFreshApproval(payload);
      expect(r).toEqual({ qualify: false, reason: "malformed_payload" });
    });

    it("rejects: entirely empty payload", () => {
      expect(evaluateFreshApproval({})).toEqual({ qualify: false, reason: "malformed_payload" });
    });

    it("rejects: null payload", () => {
      expect(evaluateFreshApproval(null)).toEqual({ qualify: false, reason: "malformed_payload" });
    });
  });
});

describe("handleFreshApproval (side-effecting handler)", () => {
  function fakeOctokit() {
    return { checks: { create: vi.fn().mockResolvedValue({}) } } as any;
  }

  it("qualify: calls the actuator to set check success on the head SHA", async () => {
    const octokit = fakeOctokit();
    await handleFreshApproval(basePayload(), { octokit, owner: "org", repo: "repo", dryRun: false });

    expect(octokit.checks.create).toHaveBeenCalledTimes(1);
    const call = octokit.checks.create.mock.calls[0][0];
    expect(call.head_sha).toBe(HEAD_SHA);
    expect(call.status).toBe("completed");
    expect(call.conclusion).toBe("success");
  });

  it("non-qualify: never touches GitHub (pure no-op, never sets failure)", async () => {
    const octokit = fakeOctokit();
    await handleFreshApproval(basePayload({ reviewState: "changes_requested" }), {
      octokit, owner: "org", repo: "repo", dryRun: false,
    });
    expect(octokit.checks.create).not.toHaveBeenCalled();
  });

  it("dryRun: qualify still no-ops on GitHub (shadow mode)", async () => {
    const octokit = fakeOctokit();
    await handleFreshApproval(basePayload(), { octokit, owner: "org", repo: "repo", dryRun: true });
    expect(octokit.checks.create).not.toHaveBeenCalled();
  });
});
