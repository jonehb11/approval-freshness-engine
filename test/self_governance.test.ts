import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stage0, SELF_GOVERNANCE_GLOBS } from "../src/stages/stage0_hardrules.js";
import { Action, Delta } from "../src/stages/types.js";
import { testConfig } from "./helpers.js";

// testConfig().selfGovernedRepos === ["test-org/approval-freshness-engine"].
const SELF_REPO = "test-org/approval-freshness-engine";

const base: Delta = {
  repo: SELF_REPO,
  approvedSha: "a", headSha: "b", changedFiles: [], addedLines: 1, removedLines: 0,
  commitAuthors: ["alice"], prAuthor: "alice", forcePushed: false, baseChanged: false, patchByFile: {},
};

describe("stage0 rule 0: engine never grades changes to its own control surface", () => {
  it("dismisses self_governance when a self-repo PR touches src/model/prompt.ts (even 1 whitespace line)", () => {
    const d = stage0({ ...base, changedFiles: ["src/model/prompt.ts"],
      patchByFile: { "src/model/prompt.ts": "+ \n" } }, testConfig());
    expect(d?.action).toBe(Action.DISMISS);
    expect(d?.reason).toBe("self_governance");
  });

  it("takes precedence: it is checked before force-push / foreign-author on a self-repo control-surface change", () => {
    // Even with an otherwise-tripping condition present, the self-governance reason wins
    // because it is rule 0.
    const d = stage0({ ...base, changedFiles: ["src/stages/ladder.ts"], forcePushed: true }, testConfig());
    expect(d?.reason).toBe("self_governance");
  });

  it("covers the gate-implementation files themselves: pr.ts / auth.ts / index.ts each trip self_governance", () => {
    // Regression pin for the adversarial-review finding: a self-repo PR that edits the code
    // IMPLEMENTING the gates (identity resolution, webhook signature verification, event
    // dispatch) must never be gradable by the engine — these are as much control surface as
    // the stage files. If SELF_GOVERNANCE_GLOBS ever narrows below directory-wide src/github
    // coverage or drops src/index.ts, this fails.
    for (const file of ["src/github/pr.ts", "src/github/auth.ts", "src/index.ts", "src/audit/logger.ts"]) {
      const d = stage0({ ...base, changedFiles: [file], patchByFile: { [file]: "+ x" } }, testConfig());
      expect(d?.reason, `${file} must be self-governed`).toBe("self_governance");
    }
  });

  it("falls through (null) for an ordinary self-repo file not on the control surface", () => {
    const d = stage0({ ...base, changedFiles: ["src/somethingelse.ts"],
      patchByFile: { "src/somethingelse.ts": "+ const x = 1;" } }, testConfig());
    expect(d).toBeNull();
  });

  it("case-evasion: 'SRC/Model/Prompt.ts' casing still trips (nocase)", () => {
    const d = stage0({ ...base, changedFiles: ["SRC/Model/Prompt.ts"],
      patchByFile: { "SRC/Model/Prompt.ts": "+ x" } }, testConfig());
    expect(d?.reason).toBe("self_governance");
  });

  it("non-self repo: a .github/workflows change is NOT self_governance (proves no behavior change for enrolled repos)", () => {
    // A non-self repo touching .github/workflows must dismiss via the EXISTING denylist rule,
    // not self_governance — the self-governance gate applies only to the engine's own repos.
    const d = stage0({ ...base, repo: "acme/widget", changedFiles: [".github/workflows/ci.yaml"] }, testConfig());
    expect(d?.action).toBe(Action.DISMISS);
    expect(d?.reason).toBe("denylist_path");
  });
});

describe("SELF_GOVERNANCE_GLOBS stays 1:1 with .github/CODEOWNERS (sync guard)", () => {
  // Parse CODEOWNERS as text only (no filesystem stat) so forward-looking entries such as
  // /config/ (a not-yet-created dir) do not fail the guard.
  const here = dirname(fileURLToPath(import.meta.url));
  const codeownersPath = join(here, "..", ".github", "CODEOWNERS");
  const codeownersPaths = new Set(
    readFileSync(codeownersPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((l) => l.split(/\s+/)[0]),
  );

  // Every glob's path prefix maps to exactly one CODEOWNERS entry:
  //   "src/model/**"                -> "/src/model/"
  //   "src/github/freshApproval.ts" -> "/src/github/freshApproval.ts"
  const prefixOf = (glob: string) => "/" + glob.replace(/\/\*\*$/, "/");

  it("every SELF_GOVERNANCE_GLOB is covered by a CODEOWNERS entry", () => {
    for (const glob of SELF_GOVERNANCE_GLOBS) {
      expect(codeownersPaths, `CODEOWNERS is missing an owner for glob ${glob} (expected ${prefixOf(glob)})`)
        .toContain(prefixOf(glob));
    }
  });

  it("every CODEOWNERS entry is backed by a SELF_GOVERNANCE_GLOB (no drift in the other direction)", () => {
    const globPrefixes = new Set(SELF_GOVERNANCE_GLOBS.map(prefixOf));
    for (const p of codeownersPaths) {
      expect(globPrefixes, `CODEOWNERS entry ${p} has no matching SELF_GOVERNANCE_GLOB`).toContain(p);
    }
  });
});
