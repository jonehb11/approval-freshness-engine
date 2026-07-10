import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The single most important test: PROVE the actuator has no approve path.
describe("invariant: the engine can never approve", () => {
  it("actuator source contains no APPROVE review event", () => {
    const src = readFileSync(new URL("../src/github/actuator.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/event\s*:\s*["']APPROVE["']/);
    expect(src).not.toMatch(/createReview\s*\(/);
  });
  it("decision Action enum has no approve member", async () => {
    const mod = await import("../src/stages/types.js");
    expect(Object.values(mod.Action)).toEqual(["dismiss", "preserve"]);
  });
});
