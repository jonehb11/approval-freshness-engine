import { describe, it, expect } from "vitest";
import { stage0 } from "../src/stages/stage0_hardrules.js";
import { Delta, Action } from "../src/stages/types.js";
import { testConfig } from "./helpers.js";

/**
 * Hand-resolved merge conflicts must never keep an approval.
 *
 * This is the one case the engine could not see by reasoning about its own diff. The engine
 * compares approvedSha → head ON THE PR BRANCH. A conflict resolution that DISCARDS a change
 * coming from the base branch leaves the PR's own files byte-identical to what was approved, so
 * that diff shows nothing at all — the deletion is only visible against the base.
 *
 * Verified live before this rule existed: a resolution that silently dropped main's
 * `if (!user.verified) throw new Error("unverified")` guard came back PRESERVED
 * (model_low_impact_gated) with merge state clean. An unreviewed removal of a security check.
 */
function delta(over: Partial<Delta> = {}): Delta {
  return {
    repo: "o/r", approvedSha: "a".repeat(40), headSha: "b".repeat(40),
    changedFiles: ["src/rate.js"], addedLines: 2, removedLines: 3,
    commitAuthors: ["dev"], prAuthor: "dev",
    forcePushed: false, baseChanged: false,
    patchByFile: { "src/rate.js": "+  return user.premium ? 100 : 10;\n" },
    ...over,
  };
}

describe("hand-resolved merge conflicts are dismissed categorically", () => {
  it("dismisses when the merge altered the proposal", () => {
    const d = stage0(delta({ mergeAlteredProposal: true }), testConfig());
    expect(d?.action).toBe(Action.DISMISS);
    expect(d?.reason).toBe("merge_conflict_resolution");
  });

  it("dismisses even when the PR's own files look unchanged since approval", () => {
    // The exact live shape: the resolution dropped a base-branch guard, so nothing in the
    // approved→head diff for the PR's files reveals it.
    const d = stage0(delta({ mergeAlteredProposal: true, changedFiles: [], patchByFile: {}, addedLines: 0, removedLines: 0 }), testConfig());
    expect(d?.reason).toBe("merge_conflict_resolution");
  });

  it("dismisses ahead of the force-push rule, so the reason is specific", () => {
    const d = stage0(delta({ mergeAlteredProposal: true, forcePushed: true }), testConfig());
    expect(d?.reason).toBe("merge_conflict_resolution");
  });

  it("does not fire for a clean update-branch merge", () => {
    // classifyMerge reports "clean" for those, and buildDelta emits an empty tree delta with
    // baseChanged — no mergeAlteredProposal flag.
    expect(stage0(delta({ changedFiles: [], patchByFile: {}, baseChanged: true, addedLines: 0, removedLines: 0 }), testConfig())).toBeNull();
  });

  it("does not fire for an ordinary push", () => {
    expect(stage0(delta(), testConfig())).toBeNull();
  });
});
