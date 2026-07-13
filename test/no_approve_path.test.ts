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
    if (statSync(join(dirPath, file)).isDirectory()) {
      arrayOfFiles = getAllFiles(join(dirPath, file), arrayOfFiles);
    } else {
      if (file.endsWith(".ts")) arrayOfFiles.push(join(dirPath, file));
    }
  }
  return arrayOfFiles;
}

// The single most important test: PROVE the actuator has no approve path.
describe("invariant: the engine can never approve", () => {
  it("actuator source contains no APPROVE review event", () => {
    const src = readFileSync(join(SRC_DIR, "github", "actuator.ts"), "utf8");
    expect(src).not.toMatch(/event\s*:\s*["']APPROVE["']/);
    expect(src).not.toMatch(/createReview\s*\(/);
  });

  it("decision Action enum has no approve member", async () => {
    const mod = await import("../src/stages/types.js");
    expect(Object.values(mod.Action)).toEqual(["dismiss", "preserve"]);
  });

  describe("adversarial static analysis on all source files", () => {
    const allFiles = getAllFiles(SRC_DIR);

    for (const file of allFiles) {
      it(`file ${file.replace(SRC_DIR, '')} is free of approving APIs and obfuscation`, () => {
        const content = readFileSync(file, "utf8");

        // 1. Direct API bans: no createReview, submitReview, or generic request
        expect(content).not.toMatch(/\.createReview\s*\(/);
        expect(content).not.toMatch(/\.submitReview\s*\(/);
        expect(content).not.toMatch(/octokit\.request\s*\(/); // Prevents POST /repos/.../reviews
        
        // 2. Base64 encoded "APPROVE" (QVBQUk9WRQ== or QVBQUk9WR)
        expect(content).not.toContain("QVBQUk9WR");
        
        // 3. Hex/Unicode encoded "APPROVE"
        // Look for literal \x41 or \u0041 (A), etc.
        // We will just do a simple check for any case-insensitive \x41 or \u0041 to make it hard to hide 'A'.
        // Actually, preventing dynamic evaluation is better.
        
        // 4. Ban eval and Function constructor
        expect(content).not.toMatch(/\beval\s*\(/);
        expect(content).not.toMatch(/\bnew\s+Function\s*\(/);
        
        // 5. Prevent bracket notation access on octokit properties
        // E.g. octokit["pulls"] or pulls["createReview"]
        expect(content).not.toMatch(/octokit\[/);
        expect(content).not.toMatch(/pulls\[/);
        
        // 6. Just to be absolutely safe, the literal string "APPROVE" must not exist
        // in ANY source file (except we might use "approved" in comments/logs, so we strictly look for the event form)
        expect(content).not.toMatch(/["']APPROVE["']/);
      });
    }
  });
});
