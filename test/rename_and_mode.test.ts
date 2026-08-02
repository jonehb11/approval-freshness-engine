import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stage0 } from "../src/stages/stage0_hardrules.js";
import { stage1 } from "../src/stages/stage1_difftastic.js";
import { Delta, Action } from "../src/stages/types.js";
import { testConfig } from "./helpers.js";
import { EngineConfig } from "../src/config/schema.js";

const shipped = JSON.parse(readFileSync("config/config.json", "utf8"));

function cfgShipped(): EngineConfig {
  const cfg = testConfig();
  cfg.denylist = shipped.denylist;
  cfg.trivialClasses = shipped.trivialClasses;
  return cfg;
}

function delta(over: Partial<Delta>): Delta {
  return {
    repo: "o/r", approvedSha: "a".repeat(40), headSha: "b".repeat(40),
    changedFiles: [], addedLines: 0, removedLines: 0,
    commitAuthors: ["dev"], prAuthor: "dev",
    forcePushed: false, baseChanged: false, patchByFile: {},
    ...over,
  };
}

/**
 * Renames move a file between paths, and a path is what the denylist judges. GitHub reports a
 * rename ONCE, with `filename` set to the destination — so reading only that field means a
 * privileged file can be moved OUT of its protected path and the denylist only ever sees the
 * harmless destination. Deleting a CI job by renaming it away must not be preservable.
 *
 * buildDelta now contributes BOTH ends of a rename to changedFiles; these tests pin the
 * consequence at the gate.
 */
describe("renames are judged on both the source and destination path", () => {
  it("dismisses a workflow renamed into a harmless-looking path", () => {
    const d = stage0(delta({
      changedFiles: ["docs/old-ci.txt", ".github/workflows/ci.yml"], // both ends, as buildDelta now supplies
      patchByFile: { "docs/old-ci.txt": "+x\n", ".github/workflows/ci.yml": "-x\n" },
      addedLines: 1, removedLines: 1,
    }), cfgShipped());
    expect(d?.action).toBe(Action.DISMISS);
    expect(d?.reason).toBe("denylist_path");
  });

  it("dismisses an ordinary file renamed INTO a privileged path", () => {
    const d = stage0(delta({
      changedFiles: ["src/app.js", ".github/workflows/new.yml"],
      patchByFile: { "src/app.js": "-x\n", ".github/workflows/new.yml": "+x\n" },
      addedLines: 1, removedLines: 1,
    }), cfgShipped());
    expect(d?.action).toBe(Action.DISMISS);
  });

  it("allows a rename that touches no privileged path", () => {
    expect(stage0(delta({
      changedFiles: ["src/a.js", "src/b.js"],
      patchByFile: { "src/a.js": "-x\n", "src/b.js": "+x\n" },
      addedLines: 1, removedLines: 1,
    }), cfgShipped())).toBeNull();
  });
});

/**
 * A change with zero added and zero removed lines, on a file GitHub still reports as changed, is
 * a change we cannot see in a diff: a file mode flip (chmod +x turning a data file into an
 * executable script) or a rename. difftastic would correctly report the CONTENT as identical, so
 * without this guard `ast_identical` would preserve it — the approval would survive a change that
 * makes a file executable.
 */
describe("metadata-only changes cannot earn a deterministic preserve", () => {
  it("does not preserve a mode-only change via ast_identical", async () => {
    const d = await stage1(delta({
      changedFiles: ["scripts/deploy.sh"],
      patchByFile: { "scripts/deploy.sh": "" }, // no patch: mode change only
      addedLines: 0, removedLines: 0,
    }), cfgShipped());
    expect(d).toBeNull(); // falls through for real evaluation instead of preserving
  });

  it("does not preserve a mode-only change on a documentation file via trivial_class", async () => {
    const d = await stage1(delta({
      changedFiles: ["docs/guide.md"],
      patchByFile: { "docs/guide.md": "" },
      addedLines: 0, removedLines: 0,
    }), cfgShipped());
    expect(d).toBeNull();
  });

  it("still preserves a genuine documentation edit (guard is not over-broad)", async () => {
    const d = await stage1(delta({
      changedFiles: ["docs/guide.md"],
      patchByFile: { "docs/guide.md": "+more prose\n" },
      addedLines: 1, removedLines: 0,
    }), cfgShipped());
    expect(d?.reason).toBe("trivial_class");
  });

  it("still treats a true merge-base-only delta as preservable", async () => {
    const d = await stage1(delta({ changedFiles: [], baseChanged: true }), cfgShipped());
    expect(d?.reason).toBe("merge_base_only");
  });
});
