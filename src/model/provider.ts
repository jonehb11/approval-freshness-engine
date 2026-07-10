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

// Provider-agnostic: Bedrock (in-boundary, preferred) or Anthropic API (zero-retention).
// No tools, no function-calling, single call, structured JSON out. Times out → throws → dismiss.
export async function classifyImpact(delta: Delta, cfg: EngineConfig): Promise<ModelVerdict> {
  const semanticDelta = Object.entries(delta.patchByFile)
    .map(([f, p]) => `--- ${f}\n${p}`).join("\n\n")
    .slice(0, cfg.model.maxInputChars); // hard bound on input size
  const meta = {
    files: delta.changedFiles.length,
    addedLines: delta.addedLines,
    removedLines: delta.removedLines,
  };
  const userMsg = buildUserMessage(semanticDelta, meta);

  const raw = await cfg.model.invoke({
    system: SYSTEM_PROMPT,
    user: userMsg,
    maxTokens: 512,
    timeoutMs: cfg.thresholds.modelTimeoutMs,
  });

  // Parse STRICTLY. Any deviation → throw → caller fails closed (dismiss).
  const parsed = JSON.parse(stripFences(raw));
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

function stripFences(s: string): string {
  return s.replace(/```json/gi, "").replace(/```/g, "").trim();
}
