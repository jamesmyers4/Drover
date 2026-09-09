import { describe, expect, it } from "vitest";
import {
  assertSoakDataPolicyAllowed,
  SoakBlueprintValidationError,
  SoakDataPolicyViolationError,
  validateSoakBlueprint,
} from "../../src/soak/blueprint-validation.js";
import type { SoakBlueprint } from "../../src/soak/types.js";

function makeValidBlueprint(overrides: Partial<SoakBlueprint> = {}): SoakBlueprint {
  return {
    appName: "shenny",
    version: "2026-09-09.1",
    targetBaseUrl: "https://staging.example.com",
    dataPolicy: "restricted",
    driverProvider: "ollama",
    driverModel: "llama3.1:8b",
    variationPools: [
      {
        name: "entry-happy-path",
        lane: "backbone",
        path: "/api/entries",
        examples: ["Had a calm day, nothing much to report."],
      },
      {
        name: "message-analysis-standard",
        lane: "messageAnalysis",
        path: "/api/message-analysis/analyze",
        examples: ["Analyze this conversation for tone."],
      },
    ],
    pipelineBudgets: [{ pipeline: "messageAnalysis", maxCallsPerRun: 100 }],
    pacingMsRange: { minMs: 5000, maxMs: 60000 },
    budget: { ceilingUsd: 10 },
    maxDurationHours: 8,
    ...overrides,
  };
}

function codesOf(fn: () => void): string[] {
  try {
    fn();
    return [];
  } catch (err) {
    if (err instanceof SoakBlueprintValidationError) {
      return err.issues.map((issue) => issue.code);
    }
    throw err;
  }
}

describe("validateSoakBlueprint", () => {
  it("accepts a valid blueprint", () => {
    expect(() => validateSoakBlueprint(makeValidBlueprint())).not.toThrow();
  });

  it("rejects an empty variationPools array", () => {
    const codes = codesOf(() => validateSoakBlueprint(makeValidBlueprint({ variationPools: [] })));
    expect(codes).toContain("empty-variation-pools");
  });

  it("rejects a pool with no examples", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(
        makeValidBlueprint({
          variationPools: [
            { name: "empty-pool", lane: "backbone", path: "/api/entries", examples: [] },
          ],
        }),
      ),
    );
    expect(codes).toContain("empty-pool-examples");
  });

  it("rejects a pool with a missing path", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(
        makeValidBlueprint({
          variationPools: [
            {
              name: "no-path",
              lane: "backbone",
              path: "",
              examples: ["Had a calm day."],
            },
          ],
        }),
      ),
    );
    expect(codes).toContain("invalid-pool-path");
  });

  it("rejects a pipelineBudgets entry with no matching variationPools lane", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(
        makeValidBlueprint({
          pipelineBudgets: [{ pipeline: "recordingReport", maxCallsPerRun: 10 }],
        }),
      ),
    );
    expect(codes).toContain("unmatched-pipeline-lane");
  });

  it("rejects an inverted pacingMsRange", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(makeValidBlueprint({ pacingMsRange: { minMs: 60000, maxMs: 5000 } })),
    );
    expect(codes).toContain("invalid-pacing-range");
  });

  it("rejects a negative pacingMsRange", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(makeValidBlueprint({ pacingMsRange: { minMs: -1, maxMs: 100 } })),
    );
    expect(codes).toContain("invalid-pacing-range");
  });

  it("rejects a negative pipeline budget", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(
        makeValidBlueprint({
          pipelineBudgets: [{ pipeline: "messageAnalysis", maxCallsPerRun: -1 }],
        }),
      ),
    );
    expect(codes).toContain("invalid-pipeline-budget");
  });

  it("rejects a non-integer pipeline budget", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(
        makeValidBlueprint({
          pipelineBudgets: [{ pipeline: "messageAnalysis", maxCallsPerRun: 1.5 }],
        }),
      ),
    );
    expect(codes).toContain("invalid-pipeline-budget");
  });

  it("rejects a missing budget ceiling", () => {
    const codes = codesOf(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed for the test
      validateSoakBlueprint(makeValidBlueprint({ budget: {} as any })),
    );
    expect(codes).toContain("invalid-budget-ceiling");
  });

  it("rejects a non-positive budget ceiling", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(makeValidBlueprint({ budget: { ceilingUsd: 0 } })),
    );
    expect(codes).toContain("invalid-budget-ceiling");
  });

  it("rejects a missing maxDurationHours", () => {
    const codes = codesOf(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed for the test
      validateSoakBlueprint(makeValidBlueprint({ maxDurationHours: undefined as any })),
    );
    expect(codes).toContain("invalid-max-duration");
  });

  it("rejects a non-positive maxDurationHours", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(makeValidBlueprint({ maxDurationHours: -1 })),
    );
    expect(codes).toContain("invalid-max-duration");
  });

  it("rejects an invalid dataPolicy", () => {
    const codes = codesOf(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed for the test
      validateSoakBlueprint(makeValidBlueprint({ dataPolicy: "public" as any })),
    );
    expect(codes).toContain("invalid-data-policy");
  });

  it("rejects a malformed targetBaseUrl", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(makeValidBlueprint({ targetBaseUrl: "not-a-url" })),
    );
    expect(codes).toContain("malformed-target-url");
  });

  it("rejects a missing driverProvider", () => {
    const codes = codesOf(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed for the test
      validateSoakBlueprint(makeValidBlueprint({ driverProvider: "" as any })),
    );
    expect(codes).toContain("invalid-driver-provider");
  });

  it("rejects a restricted blueprint configured with a non-Ollama driver", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(
        makeValidBlueprint({ dataPolicy: "restricted", driverProvider: "anthropic" }),
      ),
    );
    expect(codes).toContain("data-policy-violation");
  });

  it("allows a synthetic-only blueprint with a non-Ollama driverProvider today", () => {
    // ADR 0006/0009: Soak's driver is Ollama-only by construction, but the
    // guard itself only fires for `restricted` (mirrors Grader's
    // `dataPolicy`/`allowHostedEscalation` asymmetry) — a synthetic-only
    // pack isn't blocked by this particular check.
    expect(() =>
      validateSoakBlueprint(
        makeValidBlueprint({ dataPolicy: "synthetic-only", driverProvider: "anthropic" }),
      ),
    ).not.toThrow();
  });

  it("collects every issue in one pass, not just the first", () => {
    const codes = codesOf(() =>
      validateSoakBlueprint(
        makeValidBlueprint({
          variationPools: [],
          maxDurationHours: -1,
          targetBaseUrl: "not-a-url",
        }),
      ),
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        "empty-variation-pools",
        "invalid-max-duration",
        "malformed-target-url",
      ]),
    );
    expect(codes.length).toBeGreaterThanOrEqual(3);
  });

  it("each distinguishable failure produces a different, non-empty message", () => {
    const messages = new Set<string>();
    for (const overrides of [
      { variationPools: [] },
      { pipelineBudgets: [{ pipeline: "x", maxCallsPerRun: -1 }] },
      { budget: { ceilingUsd: 0 } },
      { dataPolicy: "restricted" as const, driverProvider: "anthropic" },
    ]) {
      try {
        validateSoakBlueprint(makeValidBlueprint(overrides));
      } catch (err) {
        expect(err).toBeInstanceOf(SoakBlueprintValidationError);
        const message = (err as SoakBlueprintValidationError).message;
        expect(message.length).toBeGreaterThan(0);
        messages.add(message);
      }
    }
    expect(messages.size).toBe(4);
  });
});

describe("assertSoakDataPolicyAllowed", () => {
  it("allows an ollama driver under a restricted policy", () => {
    expect(() => assertSoakDataPolicyAllowed("restricted", "ollama")).not.toThrow();
  });

  it("throws SoakDataPolicyViolationError for a non-ollama driver under a restricted policy", () => {
    expect(() => assertSoakDataPolicyAllowed("restricted", "anthropic")).toThrow(
      SoakDataPolicyViolationError,
    );
  });

  it("allows a non-ollama driver under a synthetic-only policy", () => {
    expect(() => assertSoakDataPolicyAllowed("synthetic-only", "anthropic")).not.toThrow();
  });
});
