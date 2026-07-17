import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDelta } from "../src/github/pr.js";

// Builds a fake Octokit whose compareCommitsWithBasehead returns a single page. The single
// page terminates buildDelta's pagination loop (fewer than per_page=100 items), so `status`
// is captured on the first (only) call.
function fakeOctokit(data: {
  status?: string;
  files?: any[];
  commits?: any[];
}) {
  return {
    repos: {
      compareCommitsWithBasehead: vi.fn().mockResolvedValue({
        data: {
          status: data.status ?? "ahead",
          files: data.files ?? [],
          commits: data.commits ?? [],
        },
      }),
    },
  } as any;
}

const pr = { user: { login: "alice" } };

describe("buildDelta (platform-verified identity + force-push corroboration)", () => {
  it("never reads git-author metadata for identity: unresolved account → null, even when the git author name equals the PR author", async () => {
    // The spoof: GitHub could not resolve an account (author === null) but the git-author
    // metadata is set to the PR author's login. Identity must be null, NOT the spoofed name.
    const octokit = fakeOctokit({
      status: "ahead",
      commits: [{ author: null, commit: { author: { name: "alice", email: "x@example.com" } } }],
    });
    const delta = await buildDelta(octokit, "acme", "widget", pr, "aaa", "bbb", { webhookForced: false });
    expect(delta.commitAuthors).toEqual([null]);
    expect(delta.commitAuthors).not.toContain("alice");
  });

  it("uses the GitHub-resolved login when present", async () => {
    const octokit = fakeOctokit({
      commits: [{ author: { login: "bob" }, commit: { author: { name: "spoofed", email: "x" } } }],
    });
    const delta = await buildDelta(octokit, "acme", "widget", pr, "aaa", "bbb", { webhookForced: false });
    expect(delta.commitAuthors).toEqual(["bob"]);
  });

  it("webhookForced true → forcePushed true (even when compare status is normal)", async () => {
    const octokit = fakeOctokit({ status: "ahead" });
    const delta = await buildDelta(octokit, "acme", "widget", pr, "aaa", "bbb", { webhookForced: true });
    expect(delta.forcePushed).toBe(true);
  });

  it("compare status 'diverged' → forcePushed true even with webhookForced false", async () => {
    const octokit = fakeOctokit({ status: "diverged" });
    const delta = await buildDelta(octokit, "acme", "widget", pr, "aaa", "bbb", { webhookForced: false });
    expect(delta.forcePushed).toBe(true);
  });

  it("compare status 'behind' → forcePushed true (headSha no longer contains approvedSha)", async () => {
    const octokit = fakeOctokit({ status: "behind" });
    const delta = await buildDelta(octokit, "acme", "widget", pr, "aaa", "bbb", { webhookForced: false });
    expect(delta.forcePushed).toBe(true);
  });

  it("compare status 'ahead' + webhookForced false → forcePushed false", async () => {
    const octokit = fakeOctokit({ status: "ahead" });
    const delta = await buildDelta(octokit, "acme", "widget", pr, "aaa", "bbb", { webhookForced: false });
    expect(delta.forcePushed).toBe(false);
  });

  it("populates repo as owner/name", async () => {
    const octokit = fakeOctokit({});
    const delta = await buildDelta(octokit, "acme", "widget", pr, "aaa", "bbb", { webhookForced: false });
    expect(delta.repo).toBe("acme/widget");
  });

  // Static guard: buildDelta must never fall back to the spoofable git-author metadata. Assert
  // the SOURCE of src/github/pr.ts contains no `commit.author` / `commit.committer` property
  // access, so a future edit cannot silently reintroduce the identity-spoof fallback. Scoped to
  // pr.ts alone (scripts/p0_backfill.ts legitimately reads commit.author?.date for timestamps).
  it("STATIC GUARD: src/github/pr.ts never accesses git-author metadata for identity", () => {
    const prSourcePath = fileURLToPath(new URL("../src/github/pr.ts", import.meta.url));
    const source = readFileSync(prSourcePath, "utf8");
    expect(source).not.toMatch(/commit\s*\.\s*author/);
    expect(source).not.toMatch(/commit\s*\.\s*committer/);
    // Bracket-notation and quoted-key evasions of the same fields (c["commit"]["author"],
    // destructured { author } = c.commit, etc.) — ban the quoted key names outright; pr.ts has
    // no legitimate reason to name the git-metadata fields in any form.
    expect(source).not.toMatch(/["'`]committer["'`]/);
    expect(source).not.toMatch(/\[\s*["'`]author["'`]\s*\]/);
    expect(source).not.toMatch(/\bauthor\s*}\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*commit\b/);
  });
});
