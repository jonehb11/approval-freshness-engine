import { describe, it, expect, vi } from "vitest";
import { withRateLimit } from "../src/github/client.js";

/**
 * Backoff behaviour under GitHub's rate limits — the path a mass-PR burst actually exercises.
 *
 * The failure that motivated these tests: `parseInt` on a Retry-After header that carries an
 * HTTP-date (which the RFC permits) yields NaN, and `setTimeout(NaN)` fires immediately. Three
 * "retries" would then complete in microseconds against a server that had just asked for a
 * pause — the opposite of backoff, and precisely wrong during the burst where it matters.
 */
function rateLimited(headers: Record<string, string>, status = 403) {
  const e: any = new Error("rate limited");
  e.status = status;
  e.response = { headers };
  return e;
}

describe("withRateLimit backoff", () => {
  it("retries and succeeds when GitHub asks for a short pause", async () => {
    let calls = 0;
    const out = await withRateLimit(async () => {
      if (++calls === 1) throw rateLimited({ "retry-after": "0" });
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });

  it("handles a Retry-After expressed as an HTTP-date without spinning", async () => {
    // A date ~2s out. toUTCString() truncates to whole seconds and withJitter scales by
    // 0.8-1.2, so the assertion below allows for both rather than pinning an exact duration.
    const when = new Date(Date.now() + 2000).toUTCString();
    let calls = 0;
    const started = Date.now();
    const out = await withRateLimit(async () => {
      if (++calls === 1) throw rateLimited({ "retry-after": when });
      return "ok";
    });
    expect(out).toBe("ok");
    // The point is that it BACKED OFF rather than retrying instantly, which is what the old
    // NaN path did (setTimeout(NaN) fires on the next tick).
    expect(Date.now() - started).toBeGreaterThan(800);
  });

  it("fails closed rather than waiting longer than the host can survive", async () => {
    await expect(withRateLimit(async () => {
      throw rateLimited({ "retry-after": "3600" }); // an hour
    })).rejects.toThrow(/longer than this host can wait/);
  });

  it("fails closed when the primary limit resets far in the future", async () => {
    const resetSecs = Math.floor(Date.now() / 1000) + 3600;
    await expect(withRateLimit(async () => {
      throw rateLimited({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSecs) });
    })).rejects.toThrow(/primary rate limit exhausted/);
  });

  it("treats 429 as a rate limit too, not an unexpected error", async () => {
    let calls = 0;
    const out = await withRateLimit(async () => {
      if (++calls === 1) throw rateLimited({ "retry-after": "0" }, 429);
      return "ok";
    });
    expect(out).toBe("ok");
  });

  it("surfaces the underlying status when retries are exhausted", async () => {
    await expect(withRateLimit(async () => {
      throw rateLimited({ "retry-after": "0" });
    })).rejects.toThrow(/last status 403/);
  });

  it("does not retry errors that are not rate limits", async () => {
    let calls = 0;
    await expect(withRateLimit(async () => {
      calls++;
      const e: any = new Error("not found"); e.status = 404; throw e;
    })).rejects.toThrow("not found");
    expect(calls).toBe(1);
  });
});
