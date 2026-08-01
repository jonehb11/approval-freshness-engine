import { createSign } from "node:crypto";

/**
 * GitHub App authentication: mints short-lived INSTALLATION access tokens for the engine's own
 * App identity.
 *
 * Why this must be the App and nothing else: the enrolled ruleset pins the required check via
 * `required_status_checks[].integration_id`. A check run written by any other identity — a PAT,
 * the github-actions bot, a second App — is rejected by GitHub as "not set by the expected
 * GitHub App" and does not satisfy the gate. So the engine's ability to ever turn the check
 * green is exactly its ability to authenticate as this App, and nothing here widens that: the
 * App's installation grant (checks:write, pull_requests:write, contents:read, metadata:read)
 * is fixed on GitHub's side and cannot be escalated by any token minted below.
 *
 * Secret handling: the private key is read from the environment once and never logged. Errors
 * thrown here deliberately carry only status codes and GitHub's own message, never key material.
 */

interface CachedToken {
  token: string;
  /** Epoch ms at which we stop trusting this token (GitHub's expiry minus a safety margin). */
  expiresAt: number;
}

// Bounded cache keyed by installation id — NOT by token value. Keying by token value (the
// previous getOctokit behavior) grows without bound once tokens rotate hourly and retains every
// historical token string as a live key for the process lifetime. Installation ids are a small,
// closed set, so this map's size is bounded by the number of installations the engine serves.
const tokenCache = new Map<number, CachedToken>();

/** Refresh this long before GitHub's stated expiry, so a token never expires mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Normalizes a PEM private key supplied through an environment variable. Deployment paths
 * differ in how they encode newlines: a Lambda console env var typically carries real newlines,
 * Terraform/CI paths often carry literal backslash-n. Both must produce a valid PEM.
 */
export function normalizePrivateKey(raw: string): string {
  const key = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) {
    throw new Error("GITHUB_PRIVATE_KEY does not look like a PEM private key");
  }
  return key.endsWith("\n") ? key : `${key}\n`;
}

function b64url(input: string | object): string {
  return Buffer.from(typeof input === "string" ? input : JSON.stringify(input)).toString("base64url");
}

/**
 * Mints an App JWT (RS256), valid for ~9 minutes. GitHub rejects JWTs whose `exp` is more than
 * 10 minutes out, and clock skew between us and GitHub is real, so `iat` is backdated 60s.
 */
export function mintAppJwt(appId: string, privateKeyPem: string, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url({ alg: "RS256", typ: "JWT" });
  const payload = b64url({ iat: now - 60, exp: now + 540, iss: appId });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem).toString("base64url")}`;
}

export interface AppAuthEnv {
  appId?: string;
  privateKey?: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Returns a valid installation access token for `installationId`, minting a new one only when
 * the cache is empty or the cached token is inside the expiry margin.
 *
 * Fail-closed: every failure path throws. A caller that cannot get a token cannot write a check
 * run at all, which leaves the required check unsatisfied — a blocked merge, never an open one.
 */
export async function getInstallationToken(installationId: number, env: AppAuthEnv = {}): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const appId = env.appId ?? process.env.GITHUB_APP_ID;
  const rawKey = env.privateKey ?? process.env.GITHUB_PRIVATE_KEY;
  if (!appId) throw new Error("GITHUB_APP_ID is not set; cannot authenticate as the engine App");
  if (!rawKey) throw new Error("GITHUB_PRIVATE_KEY is not set; cannot authenticate as the engine App");

  const jwt = mintAppJwt(appId, normalizePrivateKey(rawKey));
  const doFetch = env.fetchImpl ?? fetch;

  const res = await doFetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "approval-freshness-engine",
    },
  });

  if (res.status !== 201) {
    // Include GitHub's status but never the key or the JWT.
    const detail = await res.text().catch(() => "");
    throw new Error(`installation token mint failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const body = (await res.json()) as { token: string; expires_at: string };
  const expiresAt = Date.parse(body.expires_at) - EXPIRY_MARGIN_MS;
  tokenCache.set(installationId, { token: body.token, expiresAt });
  return body.token;
}

/** Test hook: clears the token cache so cases do not leak into one another. */
export function __clearTokenCacheForTest(): void {
  tokenCache.clear();
}
