import { describe, it, expect } from "vitest";
import { stage2 } from "../src/stages/stage2_classifier.js";
import { Delta, Action } from "../src/stages/types.js";
import { EngineConfig } from "../src/config/schema.js";
import { testConfig } from "./helpers.js";

/**
 * The Stage 2 corroboration gates are what make the classifier ADVISORY rather than
 * authoritative. Each test below pins a model that says "low impact, high confidence" — the most
 * permissive answer it can give — and asserts that a single deterministic gate still vetoes the
 * preserve. If any of these ever passes, the model's opinion has become sufficient on its own.
 */

/** A config whose model always returns the most permissive verdict possible. */
function permissiveConfig(): EngineConfig {
  const cfg = testConfig();
  cfg.model = {
    maxInputChars: 20000,
    invoke: async () => JSON.stringify({ impact: "low", confidence: 0.99, reasons: ["looks trivial"] }),
  };
  return cfg;
}

function deltaWith(patch: string, files = ["src/app.js"]): Delta {
  return {
    repo: "o/r", approvedSha: "a".repeat(40), headSha: "b".repeat(40),
    changedFiles: files, addedLines: 2, removedLines: 0,
    commitAuthors: ["dev"], prAuthor: "dev",
    forcePushed: false, baseChanged: false,
    patchByFile: Object.fromEntries(files.map((f) => [f, patch])),
  };
}

describe("stage 2 corroboration gates outrank the model", () => {
  it("preserves only when every gate agrees", async () => {
    const d = await stage2(deltaWith("+  const renamed = compute();\n-  const old = compute();\n"), permissiveConfig());
    expect(d.action).toBe(Action.PRESERVE);
    expect(d.reason).toBe("model_low_impact_gated");
  });

  it("vetoes a sensitive pattern even when the model says low", async () => {
    const d = await stage2(deltaWith("+  const password = readSecret();\n"), permissiveConfig());
    expect(d.action).toBe(Action.DISMISS);
    expect(d.reason).toBe("corroboration_gate_failed");
  });

  it("vetoes when the delta exceeds the soft line cap", async () => {
    const delta = deltaWith("+  const a = 1;\n");
    delta.addedLines = 500;
    const d = await stage2(delta, permissiveConfig());
    expect(d.action).toBe(Action.DISMISS);
    expect(d.reason).toBe("corroboration_gate_failed");
  });

  it("vetoes when the delta exceeds the soft file cap", async () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/m${i}.js`);
    const d = await stage2(deltaWith("+  const a = 1;\n", files), permissiveConfig());
    expect(d.action).toBe(Action.DISMISS);
    expect(d.reason).toBe("corroboration_gate_failed");
  });

  it("vetoes when a changed file has NO visible patch (binary / oversized diff)", async () => {
    // GitHub omits `patch` for binary and very large files. With nothing to inspect, every
    // content gate would otherwise pass vacuously and an unseen change could be preserved.
    const d = await stage2(deltaWith(""), permissiveConfig());
    expect(d.action).toBe(Action.DISMISS);
    expect(d.reason).toBe("corroboration_gate_failed");
  });

  it("vetoes when ONE of several files has no visible patch", async () => {
    const delta = deltaWith("+  const renamed = compute();\n", ["src/a.js", "assets/logo.png"]);
    delta.patchByFile["assets/logo.png"] = ""; // binary: GitHub sends no patch
    const d = await stage2(delta, permissiveConfig());
    expect(d.action).toBe(Action.DISMISS);
    expect(d.reason).toBe("corroboration_gate_failed");
  });

  it("vetoes when the diff was truncated before the model saw it", async () => {
    // A payload placed past the input cap would otherwise be invisible to the classifier while
    // it returns a confident "low" about the prefix it could see.
    const cfg = permissiveConfig();
    cfg.model.maxInputChars = 200;
    const huge = "+" + "x".repeat(5000) + "\n";
    const d = await stage2(deltaWith(huge), cfg);
    expect(d.action).toBe(Action.DISMISS);
    expect(d.reason).toBe("corroboration_gate_failed");
  });

  it("dismisses on low model confidence", async () => {
    const cfg = permissiveConfig();
    cfg.model.invoke = async () => JSON.stringify({ impact: "low", confidence: 0.1, reasons: [] });
    const d = await stage2(deltaWith("+  const a = 1;\n"), cfg);
    expect(d.action).toBe(Action.DISMISS);
    expect(d.reason).toBe("model_low_confidence");
  });

  it("dismisses when the model errors (fail closed)", async () => {
    const cfg = permissiveConfig();
    cfg.model.invoke = async () => { throw new Error("provider unreachable"); };
    const d = await stage2(deltaWith("+  const a = 1;\n"), cfg);
    expect(d.action).toBe(Action.DISMISS);
    expect(d.reason).toBe("model_error");
  });

  it("dismisses when the model returns malformed output (fail closed)", async () => {
    const cfg = permissiveConfig();
    cfg.model.invoke = async () => "not json at all";
    const d = await stage2(deltaWith("+  const a = 1;\n"), cfg);
    expect(d.action).toBe(Action.DISMISS);
    expect(d.reason).toBe("model_error");
  });
});

/**
 * Regression suite for the new-dependency gate.
 *
 * The first case is the exact bypass found in live testing: the gate previously required an added
 * line to BEGIN with `import`/`require`, so `const helper = require("./helper")` — the single most
 * common form in JavaScript — sailed through, and a real PR adding it was PRESERVED. Adding a
 * dependency is a supply-chain change; it must always reach a human.
 */
describe("new-dependency gate", () => {
  const mustBlock: Array<[string, string]> = [
    ["const x = require() — the live bypass", '+const helper = require("./helper");\n'],
    ["destructured require", '+const { join } = require("node:path");\n'],
    ["bare require call", '+require("side-effect");\n'],
    ["es module import", '+import lodash from "lodash";\n'],
    ["side-effect import", '+import "./polyfill";\n'],
    ["dynamic import", '+const m = await import("./late");\n'],
    ["python from-import", "+from os import path\n"],
    ["python import", "+import requests\n"],
    ["rust use", "+use serde::Serialize;\n"],
    ["c include", "+#include <stdio.h>\n"],
    ["go import path line", '+\t"github.com/pkg/errors"\n'],
    ["manifest dependency entry", '+    "lodash": "^4.17.21",\n'],
  ];

  for (const [name, patch] of mustBlock) {
    it(`blocks a preserve for: ${name}`, async () => {
      const d = await stage2(deltaWith(patch), permissiveConfig());
      expect(d.action).toBe(Action.DISMISS);
      expect(d.reason).toBe("corroboration_gate_failed");
    });
  }

  it("does not fire on a REMOVED import (that is not a new dependency)", async () => {
    const d = await stage2(deltaWith('-const helper = require("./helper");\n+const renamed = compute();\n'), permissiveConfig());
    expect(d.action).toBe(Action.PRESERVE);
  });

  it("does not fire on the word require appearing in prose", async () => {
    const d = await stage2(deltaWith("+  // these values require validation upstream\n"), permissiveConfig());
    expect(d.action).toBe(Action.PRESERVE);
  });
});
