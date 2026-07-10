/**
 * Golden-set eval harness — the security evidence for Stage 2.
 * Input: labeled historical deltas (eval/golden/*.json) each {delta, label: "trivial"|"low"|"high"}.
 * Measures Stage-1 precision and — critically — Stage-2 FALSE-PRESERVE rate on high-impact labels.
 * RELEASE GATE: false-preserve on "high" labels must be 0 within the gated envelope.
 */
import { readFileSync, readdirSync } from "node:fs";
import { evaluate } from "../src/stages/ladder.js";
import { Action } from "../src/stages/types.js";
import { loadConfig } from "../src/config/schema.js";

async function main() {
  const cfg = await loadConfig();
  const dir = new URL("./golden/", import.meta.url);
  const cases = readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));

  let falsePreserveHigh = 0, stage1Correct = 0, stage1Total = 0;
  for (const c of cases) {
    const d = await evaluate(c.delta, cfg);
    if (c.label === "high" && d.action === Action.PRESERVE) {
      falsePreserveHigh++;
      console.error(`FALSE PRESERVE on high-impact case ${c.id}: ${d.reason}`);
    }
    if (c.label === "trivial") { stage1Total++; if (d.stage <= 1 && d.action === Action.PRESERVE) stage1Correct++; }
  }
  const precision = stage1Total ? (stage1Correct / stage1Total) : 1;
  console.log(`Stage-1 precision on trivial: ${(precision * 100).toFixed(1)}%`);
  console.log(`Stage-2 false-preserve on high: ${falsePreserveHigh}`);
  if (falsePreserveHigh > 0) { console.error("RELEASE GATE FAILED"); process.exit(1); }
  if (precision < 0.95) { console.error("Stage-1 precision below 95% gate"); process.exit(1); }
  console.log("All eval gates passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
