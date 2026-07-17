import { Octokit } from "@octokit/rest";
import * as https from "node:https";

// Shared GitHub client (perf): the one place that constructs Octokit instances and hosts the
// withRateLimit retry helper that used to be copy-pasted in BOTH src/github/actuator.ts and
// src/github/pr.ts. Both files now import withRateLimit from here instead of defining their
// own copy — same behavior, one implementation. Every other file that needs to talk to GitHub
// should get its Octokit instance from getOctokit() below rather than constructing its own.

// ---------------------------------------------------------------------------------------------
// Keep-alive Agent
// ---------------------------------------------------------------------------------------------
// A single module-level Node https.Agent (stdlib, zero new deps) with connection reuse enabled,
// wired via the officially documented `options.request.agent` Octokit constructor option (see
// node_modules/@octokit/core/README.md, options.request row: "...or an http(s).Agent e.g. for
// proxy usage (Node only, options.request.agent)").
//
// VERIFIED against the actually-installed transport rather than guessed: the installed
// @octokit/request (node_modules/@octokit/request/dist-src/fetch-wrapper.js) ships a fetch()-
// based transport that only forwards {fetch, redirect, headers, signal, duplex} from
// `requestOptions.request` into the fetch() call it makes — `request.agent` is read nowhere in
// that file, so on the wire, today, this Agent has no effect. It is still constructed and wired
// because (a) it is the documented, zero-cost knob and is forward-compatible if a future
// @octokit/request version (or a caller-supplied `request.fetch`) restores support for it, and
// (b) Node's own global fetch — which is what @octokit/request actually calls — already keeps
// per-origin connections alive via its internal dispatcher by default, so real connection reuse
// happens today without adding the `undici` package as a new dependency (out of scope this
// pass; see the fetch-native replacement documented in
// node_modules/@octokit/request/README.md "Set a custom Agent to your requests" — a custom
// `request.fetch` wrapping undici's `Agent`/`dispatcher` — left as a deploy-time follow-up).
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

// ---------------------------------------------------------------------------------------------
// Request timeout
// ---------------------------------------------------------------------------------------------
// Same verify-don't-guess exercise: @octokit/core's README documents `options.request.timeout`,
// but that option predates the fetch-based transport rewrite and is read nowhere in the
// installed @octokit/{core,request,endpoint} source (grepped dist-src for "timeout": zero
// hits). What the fetch transport DOES forward is `request.signal` (an AbortSignal) — confirmed
// in fetch-wrapper.js. We inject a fresh AbortSignal.timeout() per call via Octokit's documented
// hook API (octokit.hook.wrap, see @octokit/core/README.md "Hooks") rather than one shared
// module-level signal: a signal from AbortSignal.timeout() starts counting down at creation and
// is single-use, so sharing one across every request would leave every request after the first
// window silently pre-aborted instead of getting its own fresh budget.
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------------------------
// App-auth readiness (structure only, no new deps)
// ---------------------------------------------------------------------------------------------
/**
 * A source of a GitHub auth token. EnvTokenSource (below) is the only implementation wired
 * today — it reads GITHUB_TOKEN, the same env var the pre-existing `new Octokit({auth:
 * process.env.GITHUB_TOKEN})` call sites this module replaces already relied on. The interface
 * exists so a future GitHub App installation-token source can be dropped in without touching any
 * call site: at deploy time, an AppInstallationTokenSource would mint an installation token via
 * @octokit/auth-app, cache it per installation ID until exp - 5min, and transparently refresh on
 * the next getToken() call that observes the cached token has entered that skew window.
 * Consistent with this repo's Build-honesty stance (see the loadConfig() stub comment in
 * src/config/schema.ts): we are not adding @octokit/auth-app as a dependency in this pass, only
 * the seam it will plug into.
 */
export interface TokenSource {
  getToken(): Promise<string>;
}

/**
 * Reads a static token from the GITHUB_TOKEN environment variable. Fails closed (throws)
 * rather than silently returning an empty/undefined token and letting Octokit make
 * unauthenticated requests that then fail confusingly downstream with 404s/403s.
 */
export class EnvTokenSource implements TokenSource {
  async getToken(): Promise<string> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN environment variable is not set.");
    return token;
  }
}

// ---------------------------------------------------------------------------------------------
// Octokit construction
// ---------------------------------------------------------------------------------------------
/**
 * Builds a fresh Octokit instance wired with the keep-alive agent and per-request timeout
 * described above. Most callers should use getOctokit() (below) instead — a cached singleton
 * per token — this is exported separately for the rare caller that genuinely needs an unshared
 * instance.
 *
 * @param token - Optional auth token. Omitted → unauthenticated Octokit (much lower GitHub rate
 *   limits; only useful for tests or unauthenticated public-data reads).
 */
export function makeOctokit(token?: string): Octokit {
  const octokit = new Octokit({
    auth: token,
    request: { agent: keepAliveAgent },
  });
  octokit.hook.wrap("request", async (request, options) => {
    if (!options.request.signal) {
      options.request.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    }
    return request(options);
  });
  return octokit;
}

const octokitCache = new Map<string, Octokit>();

/**
 * Returns a process-wide singleton Octokit per distinct token value. The fresh-approval echo
 * and synchronize/pending paths previously did `new Octokit(...)` on every webhook event —
 * wasteful (rebuilds the hook collection, defeats connection reuse). One instance per token is
 * safe to share: an Octokit instance is stateless aside from the auth closure and the
 * request-hook chain wired in makeOctokit, both identical for a given token.
 *
 * @param token - Optional auth token (defaults to the empty string as the cache key, so the
 *   unauthenticated case also gets a shared singleton rather than a fresh instance per call).
 */
export function getOctokit(token?: string): Octokit {
  const key = token ?? "";
  let instance = octokitCache.get(key);
  if (!instance) {
    instance = makeOctokit(token);
    octokitCache.set(key, instance);
  }
  return instance;
}

// ---------------------------------------------------------------------------------------------
// withRateLimit (deduplicated from src/github/actuator.ts and src/github/pr.ts)
// ---------------------------------------------------------------------------------------------
/**
 * Handles GitHub API rate limits (primary and secondary) with retry + backoff. Behavior is
 * unchanged from the two copies this replaces (3 attempts, retry-after + x-ratelimit-reset),
 * plus ±20% jitter on both backoff sleeps so many parallel PR evaluations that all hit the same
 * rate-limit window don't all wake up and retry in lockstep (thundering herd).
 *
 * @param fn - The GitHub API call to attempt, retrying on rate-limit responses.
 */
export async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      if (e.status === 403 && e.response?.headers) {
        const reset = e.response.headers['x-ratelimit-reset'];
        const retryAfter = e.response.headers['retry-after'];
        // Handle secondary rate limits (retry-after)
        if (retryAfter) {
          const delay = withJitter(parseInt(retryAfter, 10) * 1000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        // Handle primary rate limits (x-ratelimit-reset)
        else if (reset && e.response.headers['x-ratelimit-remaining'] === '0') {
          const delay = withJitter(Math.max(0, parseInt(reset, 10) * 1000 - Date.now()) + 1000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      throw e;
    }
  }
  throw new Error("GitHub API rate limit retries exhausted.");
}

/**
 * Applies ±20% jitter to a backoff delay (uniform in [0.8x, 1.2x]) so many parallel callers
 * backing off from the same rate-limit window don't all retry at the exact same instant.
 *
 * @param ms - The unjittered backoff delay in milliseconds.
 */
function withJitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}
