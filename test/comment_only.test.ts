import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stage0 } from "../src/stages/stage0_hardrules.js";
import { stage1 } from "../src/stages/stage1_difftastic.js";
import { Delta } from "../src/stages/types.js";
import { testConfig } from "./helpers.js";

const run = promisify(execFile);

/**
 * Comment-only changes preserve the approval — a typo fix in a docstring is not a reason to make
 * a reviewer read the whole change again. That is the product intent, and difftastic's
 * `--ignore-comments` is what makes it deterministic rather than a judgement call.
 *
 * The safety catch, and the reason this file exists: **not every comment is inert.** Ignoring
 * comments makes DIRECTIVES invisible too — `// eslint-disable-next-line no-eval` switches off a
 * security lint, `//go:build` changes what compiles, `// @ts-ignore` suppresses type checking.
 * Those are behaviour changes wearing a comment's clothes. A comment-only delta that touches one
 * must NOT preserve.
 */

function delta(patch: string, files = ["src/app.js"]): Delta {
  return {
    repo: "o/r", approvedSha: "a".repeat(40), headSha: "b".repeat(40),
    changedFiles: files, addedLines: 1, removedLines: 1,
    commitAuthors: ["dev"], prAuthor: "dev",
    forcePushed: false, baseChanged: false,
    patchByFile: Object.fromEntries(files.map((f) => [f, patch])),
    // A blob source must be present or materializeBlobs throws and every file degrades to
    // "unsupported" — which would make the directive assertions below pass for the WRONG reason
    // (fell through because nothing could be parsed, rather than because a directive was found).
    blobSource: {
      owner: "o", repo: "r",
      octokit: { repos: { getContent: async () => ({ data: "// content\nfunction f(){return 1;}\n" }) } },
    },
  };
}

/** Stage 1 with difftastic stubbed to "no structural change" — i.e. comment-only or formatting. */
function cfgIdentical() {
  const cfg = testConfig();
  // A blob source is required for real difftastic; these cases assert the DIRECTIVE decision,
  // which happens after the structural verdict, so the verdict is pinned via a difftastic
  // binary that always reports "identical".
  cfg.difftasticBin = "true"; // /usr/bin/true exits 0 = no structural change
  return cfg;
}

describe("comment-only changes preserve, directives do not", () => {
  it("preserves a reworded comment", async () => {
    const d = await stage1(delta("-// adds one\n+// adds one to the input\n"), cfgIdentical());
    expect(d?.reason).toBe("comment_only");
  });

  it("preserves an added explanatory comment", async () => {
    const d = await stage1(delta("+// NOTE: callers must hold the lock\n"), cfgIdentical());
    expect(d?.reason).toBe("comment_only");
  });

  const directives: Array<[string, string]> = [
    ["eslint suppression", "+// eslint-disable-next-line no-eval\n"],
    ["eslint re-enable removed", "-// eslint-enable no-eval\n"],
    ["typescript ignore", "+// @ts-ignore\n"],
    ["typescript expect-error", "+// @ts-expect-error\n"],
    ["go build constraint", "+//go:build linux || windows\n"],
    ["go generate", "+//go:generate mockgen -source=x.go\n"],
    ["python noqa", "+x = eval(s)  # noqa\n"],
    ["golangci nolint", "+//nolint:gosec\n"],
    ["semgrep suppression", "+// nosemgrep: dangerous-eval\n"],
  ];

  for (const [name, patch] of directives) {
    // Asserted at STAGE 0, and the placement is the point. Detecting a directive in Stage 1 and
    // merely declining to preserve there is not enough: the delta then reaches Stage 2, where a
    // model can call a one-line comment "low impact" and preserve it anyway. That happened live
    // — an added `// @ts-ignore` was PRESERVED via model_low_impact_gated while Stage 1 logged
    // that it had spotted the directive. Only a categorical Stage 0 dismissal holds on every path.
    it(`dismisses categorically at stage 0 when a directive changes: ${name}`, () => {
      const d = stage0(delta(patch), cfgIdentical());
      expect(d?.action).toBe("dismiss");
      expect(d?.reason).toBe("directive_comment");
    });
  }

  it("lets an ordinary comment past stage 0 so it can be preserved", () => {
    expect(stage0(delta("+// NOTE: callers must hold the lock\n"), cfgIdentical())).toBeNull();
  });

  it("dismisses when a directive changes in ANY of several files", () => {
    const d0 = delta("+// harmless note\n", ["src/a.js", "src/b.js"]);
    d0.patchByFile["src/b.js"] = "+// nolint:gosec\n";
    expect(stage0(d0, cfgIdentical())?.reason).toBe("directive_comment");
  });

  it("reports ast_identical (not comment_only) when nothing textual changed", async () => {
    const d = delta("", ["src/app.js"]);
    d.addedLines = 1; d.removedLines = 0; // not metadata-only; just no visible patch lines
    const out = await stage1(d, cfgIdentical());
    expect(out?.reason).toBe("ast_identical");
  });
});

/**
 * The behaviour above rests entirely on difftastic's own `--ignore-comments` semantics, so pin
 * them against the real binary where one is available. A mock here would prove nothing: the
 * original defect in this engine was precisely a wrong assumption about how difftastic behaves.
 */
describe("difftastic --ignore-comments, verified against the real binary", () => {
  const bin = process.env.DIFFT_BIN || "difft";
  let available = false;
  try { execFileSync(bin, ["--version"], { stdio: "ignore" }); available = true; } catch { available = false; }

  const pair = async (before: string, after: string) => {
    const dir = await mkdtemp(join(tmpdir(), "afe-cmt-"));
    const a = join(dir, "a.js"), b = join(dir, "b.js");
    await writeFile(a, before); await writeFile(b, after);
    return [a, b] as const;
  };

  it.runIf(available)("treats an added comment as no change", async () => {
    const [a, b] = await pair("function f(){return 1;}\n", "// helper\nfunction f(){return 1;}\n");
    await expect(run(bin, ["--exit-code", "--ignore-comments", a, b])).resolves.toBeDefined();
  });

  it.runIf(available)("treats a reworded comment as no change", async () => {
    const [a, b] = await pair("// adds one\nfunction f(){return 1;}\n", "// adds 1 to input\nfunction f(){return 1;}\n");
    await expect(run(bin, ["--exit-code", "--ignore-comments", a, b])).resolves.toBeDefined();
  });

  it.runIf(available)("still reports a code change made alongside a comment change", async () => {
    const [a, b] = await pair("// helper\nfunction f(){return 1;}\n", "// helper text\nfunction f(){return 2;}\n");
    await expect(run(bin, ["--exit-code", "--ignore-comments", a, b])).rejects.toMatchObject({ code: 1 });
  });

  it.runIf(available)("still reports a pure code change", async () => {
    const [a, b] = await pair("function f(){return 1;}\n", "function f(){return 2;}\n");
    await expect(run(bin, ["--exit-code", "--ignore-comments", a, b])).rejects.toMatchObject({ code: 1 });
  });
});
