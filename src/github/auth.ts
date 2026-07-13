import * as crypto from "node:crypto";

/**
 * Validates a GitHub webhook payload using the expected X-Hub-Signature-256 header.
 *
 * Security Posture:
 * - Uses cryptographically constant-time string comparison (`timingSafeEqual`)
 *   to prevent timing attacks which could leak the expected signature.
 * - Strict length checking before comparison to ensure buffer lengths match.
 * - Handles missing headers, empty secrets, or malformed prefixes defensively by failing closed.
 * - Ensures the HMAC relies on the raw body, not parsed objects, preventing tampering or serialization attacks.
 *
 * @param secret - The GitHub App webhook secret from configuration/environment.
 * @param header - The raw `X-Hub-Signature-256` header from the HTTP request.
 * @param rawPayload - The raw HTTP request body (as a Buffer or UTF-8 string).
 * @returns {boolean} True if the signature is valid, false otherwise (fail closed).
 */
export function verifyWebhookSignature(secret: string, header: string, rawPayload: Buffer | string): boolean {
  // 1. Fail closed on missing essential inputs.
  if (!secret || !header || !rawPayload) {
    return false;
  }

  // 2. Validate prefix format
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) {
    return false; // Missing or wrong algorithm specified.
  }

  // 3. Compute the expected HMAC signature based on the provided secret and raw payload
  let computedMac: string;
  try {
    computedMac = crypto
      .createHmac("sha256", secret)
      .update(rawPayload)
      .digest("hex");
  } catch (err) {
    // Fail closed if cryptographic operations fail
    return false;
  }

  const expectedSignature = `${prefix}${computedMac}`;

  // 4. Convert both to buffers to perform a constant-time comparison
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const actualBuffer = Buffer.from(header, "utf8");

  // 5. Short-circuit length mismatch (timingSafeEqual requires equal length)
  // This does not expose timing information about the secret itself, only the 
  // length of the expected hash, which is publicly known for SHA-256 (64 hex chars).
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  // 6. Cryptographically constant-time comparison
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}
