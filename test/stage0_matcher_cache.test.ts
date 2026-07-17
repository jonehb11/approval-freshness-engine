import { describe, it, expect } from "vitest";
import { stage0, __stage0MatcherCacheHasForTest } from "../src/stages/stage0_hardrules.js";
import { Delta } from "../src/stages/types.js";
import { testConfig } from "./helpers.js";

// Precompiled glob matching. All BEHAVIORAL equivalence is already proven by the existing
// stage0/self_governance/adversarial suites passing unchanged (same inputs -> same outputs).
// This file adds the one thing those suites can't observe: that the WeakMap cache is actually
// being populated and reused across calls with the same EngineConfig object, not silently
// recompiling every time.
const base: Delta = {
  repo: "acme/widget",
  approvedSha: "a", headSha: "b", changedFiles: ["src/util.ts"], addedLines: 1, removedLines: 0,
  commitAuthors: ["alice"], prAuthor: "alice", forcePushed: false, baseChanged: false, patchByFile: {},
};

describe("stage0 compiled-matcher WeakMap cache (micro-perf, zero behavior change)", () => {
  it("has no cache entry for a config object before stage0 has ever seen it", () => {
    const cfg = testConfig();
    expect(__stage0MatcherCacheHasForTest(cfg)).toBe(false);
  });

  it("populates the cache on first use and reuses it on a second call with the SAME cfg object", () => {
    const cfg = testConfig();
    stage0(base, cfg);
    expect(__stage0MatcherCacheHasForTest(cfg)).toBe(true);

    // A second call with the identical cfg reference must not need to recompile — there's no
    // direct hook into "did it recompile", so this asserts the observable proxy for that: the
    // cache entry for this exact object is still present (and stage0 still behaves correctly).
    const d = stage0({ ...base, changedFiles: ["infra/main.tf"] }, cfg);
    expect(d?.reason).toBe("denylist_path");
    expect(__stage0MatcherCacheHasForTest(cfg)).toBe(true);
  });

  it("keys strictly by object identity: a different (even if deep-equal) cfg object gets its own entry", () => {
    const cfgA = testConfig();
    const cfgB = testConfig(); // same content, different object reference
    stage0(base, cfgA);
    expect(__stage0MatcherCacheHasForTest(cfgA)).toBe(true);
    expect(__stage0MatcherCacheHasForTest(cfgB)).toBe(false);
  });
});
