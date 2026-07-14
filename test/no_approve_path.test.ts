import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const isDist = currentDir.endsWith(join("dist", "test"));
const projectRoot = isDist ? resolve(currentDir, "..", "..") : resolve(currentDir, "..");
const SRC_DIR = resolve(projectRoot, "src");
// Redundant liveness path: a GitHub Actions workflow that mirrors freshApproval.ts's
// semantics on GitHub's own infra. It is an OPTIONAL deployment component (an org may
// deliberately omit it and accept lower liveness — see the workflow's header comment), so
// the scan below tolerates its absence and asserts whenever it is present.
const FALLBACK_WORKFLOW = resolve(projectRoot, ".github", "workflows", "fresh-approval-fallback.yaml");
const FALLBACK_WORKFLOW_EXISTS = existsSync(FALLBACK_WORKFLOW);

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

  // The fresh-approval echo (src/github/freshApproval.ts) is the ONLY new write surface added by this
  // change set, and its entire job is to relay an approval GitHub already verified into a
  // check-run success. It must never itself create/submit a review — that would make it a
  // machine-approval path, which is exactly the invariant this whole test file exists to
  // guard. freshApproval.ts is already swept by the generic "adversarial static analysis on
  // all source files" loop above (it lives under SRC_DIR), but it gets its own explicit,
  // named assertions here too so this invariant fails loudly and specifically if it regresses.
  describe("fresh-approval echo has no review-creation path", () => {
    it("src/github/freshApproval.ts contains no review-creation API calls", () => {
      const content = readFileSync(join(SRC_DIR, "github", "freshApproval.ts"), "utf8");
      expect(content).not.toMatch(/\.createReview\s*\(/);
      expect(content).not.toMatch(/\.submitReview\s*\(/);
      expect(content).not.toMatch(/octokit\.request\s*\(/);
      expect(content).not.toMatch(/["']APPROVE["']/);
    });

    // The redundant liveness workflow runs on GitHub's own infra and authenticates as the
    // same App, so it carries the identical risk: it must write a check success, never an
    // approving review. It is an optional deployment component (an org may deliberately omit
    // it), so this test skips if the file is absent and runs unconditionally whenever it is
    // present — there is no separate opt-in step.
    const workflowTest = FALLBACK_WORKFLOW_EXISTS ? it : it.skip;
    workflowTest(
      ".github/workflows/fresh-approval-fallback.yaml contains no approving-review creation",
      () => {
        const content = readFileSync(FALLBACK_WORKFLOW, "utf8");
        // 1. No octokit/REST call that creates a review at all, approving or otherwise.
        expect(content).not.toMatch(/pulls\.createReview/);
        expect(content).not.toMatch(/createPullRequestReview/i);
        // 2. No POST to the reviews sub-resource (raw `gh api` / curl / github-script form).
        expect(content).not.toMatch(/\/pulls\/[^\s"']*\/reviews\b/);
        expect(content).not.toMatch(/reviews["']?\s*,?\s*method:\s*["']POST["']/i);
        // 3. No APPROVE review event anywhere (JSON body, gh api --field, etc).
        expect(content).not.toMatch(/event["']?\s*[:=]\s*["']APPROVE["']/i);
        expect(content).not.toMatch(/["']APPROVE["']/);
      },
    );
  });
});
