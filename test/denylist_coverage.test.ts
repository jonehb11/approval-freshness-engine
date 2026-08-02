import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stage0 } from "../src/stages/stage0_hardrules.js";
import { Delta, Action } from "../src/stages/types.js";
import { testConfig } from "./helpers.js";
import { EngineConfig } from "../src/config/schema.js";

/**
 * Coverage for the SHIPPED denylist (config/config.json), not a test fixture.
 *
 * Stage 0 is the only categorical rule in the system: a match here dismisses before difftastic
 * or any model is consulted. The risk is not that the globs are wrong in the obvious case — it is
 * that they are anchored too tightly and miss the same file one directory deeper, or with
 * different casing, which is exactly how a privileged path reaches a preserve.
 */

const shipped = JSON.parse(readFileSync("config/config.json", "utf8"));

function cfgWithShippedDenylist(): EngineConfig {
  const cfg = testConfig();
  cfg.denylist = shipped.denylist;
  return cfg;
}

function deltaFor(file: string): Delta {
  return {
    repo: "o/r", approvedSha: "a".repeat(40), headSha: "b".repeat(40),
    changedFiles: [file], addedLines: 1, removedLines: 0,
    commitAuthors: ["dev"], prAuthor: "dev",
    forcePushed: false, baseChanged: false,
    patchByFile: { [file]: "+x\n" },
  };
}

describe("shipped denylist blocks privileged paths", () => {
  const mustBlock = [
    // CI/CD — including nested and case-evaded forms
    ".github/workflows/ci.yml",
    ".GitHub/Workflows/ci.yml",
    ".github/actions/deploy/action.yml",
    // Nested CI definitions. `docs/.github/workflows/x.yml` was PRESERVED live because the
    // pattern was anchored at the repository root; a privileged-looking path must dismiss
    // wherever it appears, even where the platform would not execute it.
    "docs/.github/workflows/x.yml",
    "sub/project/.github/workflows/ci.yml",
    "sub/.github/actions/a/action.yml",
    "services/api/Jenkinsfile",
    "sub/.gitlab-ci.yml",
    "tools/.circleci/config.yml",
    // Infrastructure as code
    "infra/modules/vpc/main.tf",
    "infra/MAIN.TF",
    "infra/vars.tfvars",
    // Production configuration, at any depth
    "config/prod/app.json",
    "a/b/c/prod/d/e.json",
    "config/Production/app.json",
    // Dependency manifests
    "package.json",
    "packages/web/package.json",
    "requirements.txt",
    "go.mod",
    "services/api/pom.xml",
    // Deployment + container definitions
    "services/api/Dockerfile",
    "deploy/helm/values.yaml",
    "deploy/helm/Chart.yaml",
    "docker-compose.yml",
    // Access control and key material
    ".github/CODEOWNERS",
    "certs/tls.pem",
    ".ssh/id_rsa.key",
    "policies/s3-policy.json",
    "infra/iam/role.json",
    // Secret-bearing filenames. Added after noticing that `secrets.txt` matched the `*.txt`
    // documentation trivial class and would otherwise have been preserved as "docs".
    ".env",
    "services/api/.env.production",
    "config/secrets.txt",
    "config/app-credentials.json",
    "keys/id_rsa",
    "certs/bundle.p12",
    "certs/store.jks",
  ];

  for (const file of mustBlock) {
    it(`dismisses a change to ${file}`, () => {
      const d = stage0(deltaFor(file), cfgWithShippedDenylist());
      expect(d).not.toBeNull();
      expect(d!.action).toBe(Action.DISMISS);
      expect(["denylist_path", "codeowners_path"]).toContain(d!.reason);
    });
  }

  const mustNotBlock = [
    "src/app.js",
    "docs/guide.md",
    "test/app.test.ts",
    "README.md",
  ];
  for (const file of mustNotBlock) {
    it(`allows ordinary source to proceed past stage 0: ${file}`, () => {
      expect(stage0(deltaFor(file), cfgWithShippedDenylist())).toBeNull();
    });
  }
});

/**
 * `requirements.txt` is both a dependency manifest (denylisted) and a `*.txt` file (documentation
 * trivial class). Stage 0 runs first and dismisses, so ordering is what keeps the manifest
 * protected — this test pins that ordering, because swapping the stages would silently turn a
 * manifest edit into a preserve.
 */
describe("denylist wins over the documentation trivial class", () => {
  it("dismisses requirements.txt despite the *.txt doc glob", () => {
    const d = stage0(deltaFor("requirements.txt"), cfgWithShippedDenylist());
    expect(d?.action).toBe(Action.DISMISS);
  });
});
