/**
 * Reference SoakBlueprint (CTS.md Soak Session 8) — a full, runnable example
 * so anyone building a real blueprint (Shenny's own session is the named
 * first consumer, per ADR 0010) has something to fork instead of starting
 * from scratch, mirroring `examples/toy-app`'s role for the simulation stack
 * and `examples/grader-toy-pack`'s role for Grader.
 *
 * `pacingMsRange` uses the low end of CTS.md's own resolved 5-60s range
 * (not below it — a soak-mode blueprint isn't the place to sneak in
 * Stampede-speed traffic) so a reference validation run finishes in a
 * couple of minutes rather than requiring a genuinely long soak to
 * demonstrate anything; `maxDurationHours` is deliberately short for the
 * same reason. A real target's own blueprint should size both to its own
 * actual "soak" duration, not copy this file's short reference values.
 *
 * `graderIntegration` is Layer-1-only by design: this build environment has
 * no local Ollama install (same gap GAPS.md already tracks elsewhere), so
 * Layers 2-7 — which all need at least one real judge model — are disabled
 * here to keep the Grader half of a reference run genuinely real-but-free
 * rather than failing on an unreachable local judge. A real target's own
 * blueprint should enable the full Layers 1-7 once real judges are
 * available (see `scripts/smoke-soak.ts`'s own explicit flag on this point).
 */

import type { SoakBlueprint } from "../../src/soak/types.js";

const DEFAULT_PORT = 4611;

const blueprint: SoakBlueprint = {
  appName: "soak-toy-fixture",
  version: "1.0.0",
  targetBaseUrl: `http://127.0.0.1:${process.env.SOAK_TOY_FIXTURE_PORT ?? DEFAULT_PORT}`,
  dataPolicy: "synthetic-only",
  driverProvider: "ollama",
  driverModel: "llama3.1:8b",
  variationPools: [
    {
      name: "entry-happy-path",
      lane: "backbone",
      path: "/api/entries",
      examples: [
        "Had a calm day, nothing much to report.",
        "Felt a bit anxious this morning but settled down by lunch.",
        "Great day overall — got a lot done and felt productive.",
      ],
      variation: { wordSubstitutionRate: 0.2, allowDetailReordering: false },
    },
    {
      name: "message-analysis-standard",
      lane: "messageAnalysis",
      path: "/api/message-analysis",
      examples: [
        "Please analyze the tone of this message for follow-up.",
        "Flag anything concerning in this conversation.",
      ],
    },
  ],
  pipelineBudgets: [{ pipeline: "messageAnalysis", maxCallsPerRun: 8 }],
  pacingMsRange: { minMs: 5000, maxMs: 15000 },
  budget: { ceilingUsd: 1 },
  maxDurationHours: 90 / 3_600,
  graderIntegration: {
    rubrics: {
      "entry-shape": {
        key: "entry-shape",
        description: "Checks that a backbone entry response is a well-formed JSON object.",
        checks: [
          { name: "is-object", description: "Output is a JSON object.", scoringType: "boolean" },
        ],
      },
    },
    rubricKeyFor: () => "entry-shape",
    layers: {
      2: { enabled: false },
      3: { enabled: false },
      4: { enabled: false },
      5: { enabled: false },
      6: { enabled: false },
      7: { enabled: false },
    },
  },
};

export default blueprint;
