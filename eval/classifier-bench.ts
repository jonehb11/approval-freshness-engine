/**
 * Stage 2 classifier bench — measures the MODEL alone, against the real production prompt.
 *
 * Distinct from eval/run.ts, which scores the whole ladder on historical deltas. This one
 * isolates the advisory layer so a model or prompt change can be judged on its own merits
 * before it is trusted anywhere near a gate.
 *
 * The two error types are not symmetric and are deliberately never averaged into one number:
 *   - A HIGH case classified "low" is a FALSE-PRESERVE CANDIDATE — the only outcome that could
 *     contribute to an unreviewed change merging. Target: zero. (Even at zero it is only a
 *     candidate: the deterministic corroboration gates in stage2_classifier.ts must also agree
 *     before anything is preserved.)
 *   - A LOW case classified "high" costs exactly one human re-review, i.e. today's behaviour.
 *     It is a utility loss, never a safety failure.
 *
 * An exception is a PASS for a high case: the ladder fails closed, so an unreachable model
 * blocks the merge.
 *
 * Usage:
 *   MODEL_ID=us.amazon.nova-lite-v1:0 npx tsx eval/classifier-bench.ts
 */
import { readFileSync } from "node:fs";
import { classifyImpact } from "../src/model/provider.js";
import { bedrockModel } from "../src/model/bedrock.js";
import { Delta } from "../src/stages/types.js";
import { EngineConfig } from "../src/config/schema.js";

interface GoldenCase { id: string; label: "low" | "high"; note: string; patch: string }

const golden = JSON.parse(
  readFileSync(new URL("./golden-set.json", import.meta.url), "utf8"),
) as { cases: GoldenCase[] };

const modelId = process.env.MODEL_ID;
if (!modelId) throw new Error("set MODEL_ID (e.g. us.amazon.nova-lite-v1:0)");

const cfg = {
  model: bedrockModel({ modelId, region: process.env.AWS_REGION || "us-east-1" }),
  thresholds: { modelTimeoutMs: 20000 },
} as unknown as EngineConfig;

function deltaFor(c: GoldenCase): Delta {
  const file = /^--- (\S+)/.exec(c.patch)?.[1] ?? "src/unknown.js";
  return {
    repo: "eval/golden", approvedSha: "a".repeat(40), headSha: "b".repeat(40),
    changedFiles: [file], addedLines: 1, removedLines: 1,
    commitAuthors: ["author"], prAuthor: "author",
    forcePushed: false, baseChanged: false,
    patchByFile: { [file]: c.patch },
  };
}

const rows: Array<{ id: string; label: string; got: string; conf: number; note: string }> = [];

for (const c of golden.cases) {
  let got = "error";
  let conf = 0;
  try {
    const v = await classifyImpact(deltaFor(c), cfg);
    got = v.impact;
    conf = v.confidence;
  } catch (e: any) {
    got = `error(${String(e?.message ?? e).slice(0, 40)})`;
  }
  rows.push({ id: c.id, label: c.label, got, conf, note: c.note });
  const mark = got === c.label ? "  ok" : got === "low" && c.label === "high" ? "UNSAFE" : "miss";
  console.log(`${mark.padEnd(6)} ${c.id.padEnd(30)} expected=${c.label.padEnd(4)} got=${got.padEnd(9)} conf=${conf}`);
}

const highs = rows.filter((r) => r.label === "high");
const lows = rows.filter((r) => r.label === "low");
const falsePreserves = highs.filter((r) => r.got === "low");
const utility = lows.filter((r) => r.got === "low").length;

console.log(`\nmodel: ${modelId}`);
console.log(`SAFETY   ${falsePreserves.length}/${highs.length} high-impact cases classified low   (target 0)`);
console.log(`UTILITY  ${utility}/${lows.length} low-impact cases classified low`);
if (falsePreserves.length) {
  console.log("\nFALSE-PRESERVE CANDIDATES — do not enable Stage 2 on this model/prompt:");
  for (const r of falsePreserves) console.log(`  - ${r.id}: ${r.note}`);
}
process.exit(falsePreserves.length === 0 ? 0 : 1);
