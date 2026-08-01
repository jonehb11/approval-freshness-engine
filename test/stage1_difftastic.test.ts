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
});
