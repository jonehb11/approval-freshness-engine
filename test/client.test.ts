import { describe, it, expect, vi, afterEach } from "vitest";
import { getOctokit, makeOctokit, withRateLimit, EnvTokenSource } from "../src/github/client.js";

// Builds a GitHub-shaped 403 rate-limit error, matching what @octokit/request throws
// (e.status + e.response.headers), which is exactly what withRateLimit's catch block reads.
function rateLimitError(headers: Record<string, string>): any {
  const err: any = new Error("rate limited");
  err.status = 403;
  err.response = { headers };
  return err;
}

describe("withRateLimit (ported behavior: 3 attempts, retry-after + x-ratelimit-reset)", () => {
  it("retries on a secondary rate limit (retry-after) and returns the eventual success", async () => {
    let calls = 0;
    const result = await withRateLimit(async () => {
      calls++;
      if (calls === 1) throw rateLimitError({ "retry-after": "0" });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries on a primary rate limit (x-ratelimit-reset + remaining=0) and returns the eventual success", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const promise = withRateLimit(async () => {
        calls++;
        if (calls === 1) {
          throw rateLimitError({
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) - 100),
            "x-ratelimit-remaining": "0",
          });
        }
        return "ok";
      });
      // Worst-case backoff here is a fixed 1000ms floor +/-20% jitter; advance well past it.
      await vi.advanceTimersByTimeAsync(2000);
      await expect(promise).resolves.toBe("ok");
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry (rethrows immediately) a non-403 error", async () => {
    const err = new Error("boom");
    await expect(withRateLimit(async () => { throw err; })).rejects.toBe(err);
  });

  it("does not retry a 403 with no rate-limit headers present", async () => {
    const err: any = new Error("forbidden");
    err.status = 403;
    await expect(withRateLimit(async () => { throw err; })).rejects.toBe(err);
  });

  it("exhausts all 3 attempts and throws once retries are used up", async () => {
    let calls = 0;
    await expect(
      withRateLimit(async () => {
        calls++;
        throw rateLimitError({ "retry-after": "0" });
      }),
    ).rejects.toThrow("GitHub API rate limit retries exhausted.");
    expect(calls).toBe(3);
  });
});

describe("getOctokit singleton cache", () => {
  it("returns the exact same Octokit instance for repeated calls with the same token", () => {
    const a = getOctokit("token-a");
    const b = getOctokit("token-a");
    expect(a).toBe(b);
  });

  it("returns a different instance for a different token", () => {
    const a = getOctokit("token-a");
    const c = getOctokit("token-c");
    expect(a).not.toBe(c);
  });

  it("shares a singleton for the unauthenticated (undefined token) case too", () => {
    const a = getOctokit();
    const b = getOctokit();
    expect(a).toBe(b);
  });

  it("makeOctokit always builds a fresh, uncached instance", () => {
    const a = makeOctokit("token-fresh");
    const b = makeOctokit("token-fresh");
    expect(a).not.toBe(b);
  });
});

describe("EnvTokenSource", () => {
  const original = process.env.GITHUB_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = original;
  });

  it("resolves the token from GITHUB_TOKEN", async () => {
    process.env.GITHUB_TOKEN = "abc123";
    await expect(new EnvTokenSource().getToken()).resolves.toBe("abc123");
  });

  it("fails closed (throws) when GITHUB_TOKEN is unset", async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(new EnvTokenSource().getToken()).rejects.toThrow();
  });
});
