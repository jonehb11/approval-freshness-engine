import { Delta } from "../stages/types.js";
import { EngineConfig } from "../config/schema.js";
import { SYSTEM_PROMPT, buildUserMessage, PROMPT_VERSION } from "./prompt.js";

export interface ModelVerdict {
  impact: "low" | "high";
  confidence: number;
  reasons: string[];
  signals?: Record<string, boolean>;
  promptVersion: string;
}

/**
 * Calls the AI provider to classify the impact of the given delta.
 * Fail-Closed Invariant: No tools or function-calling are permitted. The model's response
 * is strictly validated. Any timeout, parse failure, missing fields, or deviation from
 * expected structure throws an error, triggering a DISMISS.
 *
 * @param delta - The change context.
 * @param cfg - The runtime engine configuration.
 * @returns A promise resolving to a strictly validated ModelVerdict.
 */
export async function classifyImpact(delta: Delta, cfg: EngineConfig): Promise<ModelVerdict> {
  const semanticDelta = Object.entries(delta.patchByFile)
    .map(([f, p]) => `--- ${f}\n${p}`).join("\n\n")
    .replace(/```/g, "\\`\\`\\`") // Defang markdown fences
    .replace(/<(system|instruction|user|assistant|diff|\/)/gi, "<\\$1") // Defang xml-like prompt injections
    .slice(0, cfg.model.maxInputChars); // hard bound on input size
  const meta = {
    files: delta.changedFiles.length,
    addedLines: delta.addedLines,
    removedLines: delta.removedLines,
  };
  const userMsg = buildUserMessage(semanticDelta, meta);

  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Model invocation timeout")), cfg.thresholds.modelTimeoutMs);
  });

  let raw: string;
  try {
    raw = await Promise.race([
      cfg.model.invoke({
        system: SYSTEM_PROMPT,
        user: userMsg,
        maxTokens: 512,
        timeoutMs: cfg.thresholds.modelTimeoutMs,
      }),
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timeoutId!);
  }

  // Parse STRICTLY. Any deviation → throw → caller fails closed (dismiss).
  let parsed: any;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (err) {
    throw new Error("Malformed JSON response");
  }

  if (!parsed || typeof parsed !== "object") throw new Error("bad json root");
  if (parsed.impact !== "low" && parsed.impact !== "high") throw new Error("bad impact field");
  if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1)
    throw new Error("bad confidence field");
  if (!Array.isArray(parsed.reasons)) throw new Error("bad reasons field");

  return {
    impact: parsed.impact,
    confidence: parsed.confidence,
    reasons: parsed.reasons.slice(0, 8).map(String),
    signals: parsed.signals ?? {},
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * Strips markdown code fences from the model's raw string output.
 * Fail-Closed Invariant: If stripping fails to produce valid JSON, the downstream JSON.parse
 * will throw an error, causing a fail-closed sequence.
 *
 * @param s - The raw model string output.
 * @returns The cleaned string.
 */
function stripFences(s: string): string {
  const match = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match) return match[1].trim();

  const jsonStart = s.indexOf("{");
  const jsonEnd = s.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd >= jsonStart) {
    return s.slice(jsonStart, jsonEnd + 1).trim();
  }

  return s.replace(/```json/gi, "").replace(/```/g, "").trim();
}
