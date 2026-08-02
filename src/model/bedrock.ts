import { EngineConfig } from "../config/schema.js";

/**
 * Amazon Bedrock model provider for the Stage 2 advisory classifier.
 *
 * Scope discipline: this returns raw text and nothing else. It performs no retries, no tool
 * calls, no streaming, and no agent loop — the classifier is one bounded request/response.
 * Validation of the model's answer lives in provider.ts (strict JSON shape) and the
 * corroboration gates in stage2_classifier.ts, both of which fail closed. Every error path
 * here THROWS, which the ladder converts into a dismissal.
 *
 * Credentials come from the Lambda execution role via the standard AWS credential chain; no
 * key material is read, held, or logged by this module.
 */

export interface BedrockOptions {
  modelId: string;
  region: string;
}

interface BedrockTextBlock { type?: string; text?: string }
interface BedrockResponse {
  /** Anthropic-format response. */
  content?: BedrockTextBlock[];
  /** Amazon Nova-format response. */
  output?: { message?: { content?: BedrockTextBlock[] } };
}

/**
 * Builds the `model.invoke` function EngineConfig expects. Uses the Bedrock Runtime REST API
 * over plain fetch with SigV4 signing so the deployment carries no AWS SDK bundle — the Lambda
 * artifact stays small and the dependency surface stays minimal.
 */
export function bedrockModel(opts: BedrockOptions): EngineConfig["model"] {
  return {
    maxInputChars: 20000,
    invoke: async ({ system, user, maxTokens, timeoutMs }) => {
      // Bedrock does not present one request shape for all vendors: Anthropic models take the
      // Messages format, Amazon Nova takes content-block arrays under inferenceConfig. Which one
      // to send is decided by the model id alone, so switching providers is a config change and
      // never a code change.
      const isNova = /amazon\.nova/i.test(opts.modelId);
      const body = isNova
        ? JSON.stringify({
            system: [{ text: system }],
            messages: [{ role: "user", content: [{ text: user }] }],
            inferenceConfig: { maxTokens, temperature: 0 },
          })
        : JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: maxTokens,
            temperature: 0,      // deterministic: the same delta should classify the same way
            system,
            messages: [{ role: "user", content: user }],
          });

      const host = `bedrock-runtime.${opts.region}.amazonaws.com`;
      // The model id contains ':' (e.g. "…-v1:0"), so it must be percent-encoded in the URL.
      const path = `/model/${encodeURIComponent(opts.modelId)}/invoke`;
      // SigV4 requires each path segment to be URI-encoded TWICE for every service except S3.
      // The wire path carries %3A; the canonical request must carry %253A. Signing the wire
      // path instead produces a signature mismatch that AWS reports only as a bare HTTP 403.
      const canonicalPath = `/model/${encodeURIComponent(encodeURIComponent(opts.modelId))}/invoke`;
      const headers = await signRequest({
        method: "POST", host, path: canonicalPath, body, region: opts.region, service: "bedrock",
      });

      // Independent of the caller's own race-based timeout in provider.ts: an abandoned socket
      // would otherwise keep the Lambda alive past the verdict it can no longer use.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(`https://${host}${path}`, { method: "POST", headers, body, signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        // Include Bedrock's own `message` field only — never the raw body, which can echo request
        // content (i.e. diff text). Without it, a signing mistake and a revoked model grant are
        // both just "HTTP 403", which is not enough to operate on.
        let detail = "";
        try {
          const err = (await res.json()) as { message?: string };
          if (typeof err?.message === "string") detail = ` — ${err.message.slice(0, 200)}`;
        } catch { /* non-JSON error body: status alone */ }
        throw new Error(`bedrock invoke failed: HTTP ${res.status}${detail}`);
      }

      const json = (await res.json()) as BedrockResponse;
      const text = isNova
        ? (json.output?.message?.content ?? []).map((b) => b.text ?? "").join("")
        : (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      // An empty completion is not a "low impact" answer — it is no answer. Throwing here routes
      // it to the ladder's fail-closed path rather than into JSON parsing of an empty string.
      if (!text) throw new Error("bedrock returned no text content");
      return text;
    },
  };
}

/**
 * Minimal SigV4 signer for a single POST. Written out rather than pulled from the SDK to keep
 * the bundle small; it covers exactly one request shape and nothing more.
 */
async function signRequest(args: {
  method: string; host: string; path: string; body: string; region: string; service: string;
}): Promise<Record<string, string>> {
  const { createHash, createHmac } = await import("node:crypto");
  const sha256 = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
  const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) throw new Error("no AWS credentials in the environment for Bedrock");

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256(args.body);
  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${args.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    (sessionToken ? `x-amz-security-token:${sessionToken}\n` : "");
  const signedHeaders = `content-type;host;x-amz-content-sha256;x-amz-date${sessionToken ? ";x-amz-security-token" : ""}`;

  const canonicalRequest = [
    args.method, args.path, "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, args.region);
  const kService = hmac(kRegion, args.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  return headers;
}
