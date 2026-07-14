import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const isDist = currentDir.endsWith(join("dist", "test"));
const projectRoot = isDist ? resolve(currentDir, "..", "..") : resolve(currentDir, "..");
const SRC_DIR = resolve(projectRoot, "src");

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
  const files = readdirSync(dirPath);
  for (const file of files) {
    const full = join(dirPath, file);
    if (statSync(full).isDirectory()) {
      arrayOfFiles = getAllFiles(full, arrayOfFiles);
    } else if (file.endsWith(".ts")) {
      arrayOfFiles.push(full);
    }
  }
  return arrayOfFiles;
}

// Strips comments so prose that documents/explains the ban (which necessarily quotes the
// forbidden words, e.g. this very file's neighbors do so in doc comments) doesn't self-trigger
// the guard — only actual code tokens (string literals a running program could evaluate) count.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/.*$/gm, "");        // line comments
}

// Fail-open guard: GitHub's `neutral` and `skipped` check-run conclusions
// SATISFY a required status check — identically to `success` — from the ruleset's point of
// view (docs.github.com troubleshooting-required-status-checks). If any code path in this
// engine ever emitted either as a literal conclusion value, that would be a silent fail-OPEN
// bug: a required check could be satisfied without the engine ever having verified anything.
// This test statically scans every source file (comments stripped) for those two literals
// appearing as quoted string tokens, so a future edit — even one that doesn't touch
// actuator.ts — cannot reintroduce them anywhere in src/.
describe("invariant: engine check conclusions are exactly {success, failure} (F5 fail-open guard)", () => {
  const allFiles = getAllFiles(SRC_DIR);

  it("scanned at least one file (sanity check the scan itself is not vacuous)", () => {
    expect(allFiles.length).toBeGreaterThan(0);
    expect(allFiles.some((f) => f.endsWith(join("github", "actuator.ts")))).toBe(true);
  });

  for (const file of allFiles) {
    it(`file ${file.replace(SRC_DIR, "")} never uses "neutral" or "skipped" as a string literal`, () => {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code).not.toMatch(/(["'])neutral\1/);
      expect(code).not.toMatch(/(["'])skipped\1/);
    });
  }

  it("the actuator types every conclusion parameter as the narrow union, never a bare string", () => {
    const src = readFileSync(join(SRC_DIR, "github", "actuator.ts"), "utf8");
    // Every conclusion-typed parameter/field in the actuator must be the exact narrow union
    // below, never a bare `string` — a widened type would silently permit "neutral"/"skipped"
    // to flow through from any future caller without a compile error.
    expect(src).toMatch(/conclusion:\s*"success"\s*\|\s*"failure"/);
    expect(src).not.toMatch(/conclusion:\s*string(?!\s*\|)/);
  });
});
