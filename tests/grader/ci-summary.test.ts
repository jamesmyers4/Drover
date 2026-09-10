/**
 * `buildGraderCiSummary` (Grader Session 7; ADR 0005) — the durable,
 * versioned CI JSON contract. The golden-file test below is deliberate:
 * this schema is meant to be hard to silently drift, exactly the property
 * ADR 0005 called out ("hard to reverse once Shenny builds against it").
 */
import { describe, expect, it } from "vitest";
import { buildGraderCiSummary, CI_SUMMARY_SCHEMA_VERSION } from "../../src/grader/ci-summary.js";
import type { GradingReport } from "../../src/grader/report.js";
import type { Rubric } from "../../src/grader/types.js";
import { expectMatchesGolden } from "../golden/golden-file.js";

const toneRubric: Rubric = {
  key: "tone-eval",
  description: "Scores tone.",
  checks: [{ name: "on-brand-tone", description: "Warm, not clinical.", scoringType: "boolean" }],
};

function makeReport(overrides?: Partial<GradingReport>): GradingReport {
  return {
    gradingRunId: "grading-run-1",
    appName: "toy-app",
    status: "completed",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    packConfig: {
      appName: "toy-app",
      rubrics: { "tone-eval": toneRubric },
      dataPolicy: "synthetic-only",
    },
    casesProcessed: 1,
    tasksPassed: 4,
    tasksFailed: 0,
    tasksSkipped: 0,
    totalEscalations: 1,
    cases: [
      {
        caseId: "case-1",
        rubricKey: "tone-eval",
        // Deliberately sensitive-looking content, to confirm the CI summary
        // never carries it through (input/output stay out of this contract
        // by design — see ci-summary.ts's own header comment).
        input: { context: "internal notes: do not repeat" },
        output: { text: "Welcome aboard!" },
        layers: {
          1: { status: "pass", checks: [{ name: "output-present", value: true, reasoning: "ok" }] },
          4: {
            status: "pass",
            checks: [
              {
                name: "on-brand-tone",
                value: true,
                reasoning:
                  "Judges disagreed on this Check; a scoped escalation Task adjudicated the final value.",
              },
            ],
          },
        },
        escalationCount: 1,
        skipCount: 0,
      },
    ],
    rubricsUsed: {
      "tone-eval": { key: "tone-eval", contentHash: "abc123hash456", content: toneRubric },
    },
    ...overrides,
  };
}

describe("buildGraderCiSummary", () => {
  it("carries schemaVersion and the report's own aggregate fields through unchanged", () => {
    const summary = buildGraderCiSummary(makeReport());

    expect(summary.schemaVersion).toBe(CI_SUMMARY_SCHEMA_VERSION);
    expect(summary.gradingRunId).toBe("grading-run-1");
    expect(summary.status).toBe("completed");
    expect(summary.casesProcessed).toBe(1);
    expect(summary.totalEscalations).toBe(1);
  });

  it("never carries a Case's input/output through — only verdict/metadata", () => {
    const summary = buildGraderCiSummary(makeReport());
    const [caseSummary] = summary.cases;

    expect(caseSummary).not.toHaveProperty("input");
    expect(caseSummary).not.toHaveProperty("output");
    expect(caseSummary?.caseId).toBe("case-1");
    expect(caseSummary?.escalationCount).toBe(1);
  });

  it("preserves per-Check resolution detail — never collapsed to bare pass/fail (ADR 0005)", () => {
    const summary = buildGraderCiSummary(makeReport());
    const layer4 = summary.cases[0]?.layers[4];

    expect(layer4?.status).toBe("pass");
    expect(layer4?.checks).toEqual([
      {
        name: "on-brand-tone",
        value: true,
        reasoning:
          "Judges disagreed on this Check; a scoped escalation Task adjudicated the final value.",
      },
    ]);
  });

  it("embeds the same self-contained rubricsUsed map the markdown report carries", () => {
    const summary = buildGraderCiSummary(makeReport());
    expect(summary.rubricsUsed["tone-eval"]?.content).toEqual(toneRubric);
  });

  it("matches the golden snapshot for the durable JSON contract shape", () => {
    expectMatchesGolden("ci-summary-mixed", buildGraderCiSummary(makeReport()));
  });
});
