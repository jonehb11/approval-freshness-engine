import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const SRC = "src/stages/stage1_difftastic.ts";

/**
 * Regression guard for the defect that made Stage 1 dark in production.
 *
 * difftastic treats `--display json` as an UNSTABLE feature: without DFT_UNSTABLE=yes it
 * refuses and exits 2. Stage 1 maps exit code 2 to "unsupported", and "unsupported" forbids an
 * ast_identical preserve — so passing that flag silently disabled the entire deterministic
 * preserve path (the engine's headline capability) while every health signal stayed green.
 * It was invisible to unit tests because nothing executed the real binary.
 *
 * The invocation only ever consumes difftastic's EXIT CODE; stdout is not parsed. So the rule
 * is simply: do not request an unstable output mode, and if one is ever requested, opt in.
 */
describe("stage 1 difftastic invocation", () => {
  const source = readFileSync(SRC, "utf8");

  it("does not request difftastic's unstable JSON display without opting in", () => {
    const asksForJson = /"--display",\s*"json"/.test(source);
    const optsIn = /DFT_UNSTABLE:\s*"yes"/.test(source);
    // Either it doesn't ask for JSON at all, or it explicitly enables the unstable feature.
    expect(asksForJson && !optsIn).toBe(false);
  });

  it("still relies on --exit-code, which is the only signal it reads", () => {
    expect(source).toMatch(/"--exit-code"/);
  });
});

/**
 * Behavioral proof against the REAL binary, when one is available (CI images and the container
 * both ship difftastic; a bare dev laptop may not). Skipped rather than mocked when absent —
 * a mock of difftastic would have happily reproduced the bug above.
 */
describe("difftastic real-binary behavior", () => {
  const bin = process.env.DIFFT_BIN || "difft";

  let available = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("node:child_process").execFileSync(bin, ["--version"], { stdio: "ignore" });
    available = true;
  } catch { available = false; }

  it.runIf(available)("exits 0 for a formatting-only change (the ast_identical case)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afe-difft-"));
    const a = join(dir, "a.js");
    const b = join(dir, "b.js");
    await writeFile(a, "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n");
    await writeFile(b, "function add(a,b){return a+b;}\n\nmodule.exports={add};\n");
    // Resolves (exit 0) => difftastic found no syntactic changes.
    await expect(run(bin, ["--exit-code", a, b])).resolves.toBeDefined();
  });

  it.runIf(available)("exits 1 for a real structural change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afe-difft-"));
    const a = join(dir, "a.js");
    const b = join(dir, "b.js");
    await writeFile(a, "function add(a, b) {\n  return a + b;\n}\n");
    await writeFile(b, "function add(a, b) {\n  return a + b + 1;\n}\n");
    await expect(run(bin, ["--exit-code", a, b])).rejects.toMatchObject({ code: 1 });
  });

  /**
   * The safety property Stage 1 rests on: difftastic must NEVER report "no syntactic changes"
   * for an edit that changes meaning. A false "identical" here is the one difftastic behaviour
   * that could contribute to preserving an approval over a real change.
   *
   * Each case below is an edit a formatter would never make. They are checked against the real
   * binary because the whole point is the binary's behaviour, not our model of it.
   */
  const mustDiffer: Array<[string, string, string, string]> = [
    ["whitespace inside a string literal", "js", 'const s = "a b";\n', 'const s = "a  b";\n'],
    ["string contents changed", "js", 'const u = "https://good.example";\n', 'const u = "https://evil.example";\n'],
    ["unicode homoglyph in an identifier", "js", "const admin = 1;\n", "const аdmin = 1;\n"],
    ["zero-width character inserted", "js", 'const s = "ok";\n', 'const s = "o​k";\n'],
    ["numeric literal widened", "js", "const n = 1;\n", "const n = 1.0;\n"],
    ["object keys reordered", "js", "const o = {a:1, b:2};\n", "const o = {b:2, a:1};\n"],
    ["comment text edited", "js", "// adds numbers\nconst a = 1;\n", "// adds two numbers\nconst a = 1;\n"],
    ["content added to an empty file", "js", "", "const evil = 1;\n"],
  ];

  for (const [name, ext, before, after] of mustDiffer) {
    it.runIf(available)(`reports a change for: ${name}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "afe-difft-"));
      const a = join(dir, `a.${ext}`);
      const b = join(dir, `b.${ext}`);
      await writeFile(a, before);
      await writeFile(b, after);
      // Rejection with code 1 is difftastic reporting a syntactic difference. Resolving (exit 0)
      // would mean it saw these as identical — a false-identical, which is the failure this
      // suite exists to catch.
      await expect(run(bin, ["--exit-code", a, b])).rejects.toMatchObject({ code: 1 });
    });
  }

  /**
   * Formatting-only edits must be recognised as null across the languages an enrolled repo is
   * likely to contain — otherwise the deterministic preserve path quietly only works for
   * JavaScript. Verified live against difftastic 0.69.0.
   *
   * JSON is deliberately absent: difftastic reports a re-indented JSON document as changed, so
   * JSON reformatting does NOT preserve. That is recorded in docs/TEST-EVIDENCE.md rather than
   * asserted here, because it is a property of difftastic we accept, not one we rely on.
   */
  const formattingOnly: Array<[string, string, string, string]> = [
    ["python", "py", "def add(a, b):\n    return a + b\n", "def add(a,b):\n  return a  +  b\n"],
    ["typescript", "ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n", "export function add(a:number,b:number):number{return a+b;}\n"],
    ["go", "go", "package m\n\nfunc Add(a int, b int) int {\n\treturn a + b\n}\n", "package m\n\nfunc Add(a int, b int) int {\n\n\treturn a + b\n\n}\n"],
    ["java", "java", "class A {\n  int add(int a, int b) {\n    return a + b;\n  }\n}\n", "class A {\n  int add(int a,int b){\n    return a+b;\n  }\n}\n"],
    ["ruby", "rb", "def add(a, b)\n  a + b\nend\n", "def add(a,b)\n    a + b\nend\n"],
    ["yaml", "yaml", "a: 1\nb: 2\n", "a:  1\nb:  2\n"],
  ];

  for (const [name, ext, before, after] of formattingOnly) {
    it.runIf(available)(`treats formatting-only ${name} as null`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "afe-difft-"));
      const a = join(dir, `a.${ext}`);
      const b = join(dir, `b.${ext}`);
      await writeFile(a, before);
      await writeFile(b, after);
      await expect(run(bin, ["--exit-code", a, b])).resolves.toBeDefined();
    });
  }
});
