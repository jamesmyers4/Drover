import { describe, it } from "vitest";
import type { GradingReport } from "../../src/grader/report.js";
import { renderGradingReportMarkdown } from "../../src/grader/report-markdown.js";
import type { Rubric } from "../../src/grader/types.js";
import { expectMatchesGolden } from "../golden/golden-file.js";

const toneRubric: Rubric = {
  key: "tone-eval",
  description: "Scores tone and overall quality.",
  checks: [
    { name: "on-brand-tone", description: "Reads as warm, not clinical.", scoringType: "boolean" },
    {
      name: "quality-score",
      description: "1-5 overall quality.",
      scoringType: "numeric",
      numericTolerance: 0.5,
      passThreshold: { comparison: "gte", value: 3 },
    },
  ],
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
      allowHostedEscalation: false,
    },
    casesProcessed: 2,
    tasksPassed: 3,
    tasksFailed: 1,
    tasksSkipped: 1,
    totalEscalations: 1,
    cases: [
      {
        caseId: "case-escalated",
        rubricKey: "tone-eval",
        input: { prompt: "hi" },
        output: { text: "hello!" },
        layers: {
          1: { status: "pass", checks: [{ name: "output-present", value: true, reasoning: "ok" }] },
          4: {
            status: "pass",
            checks: [
              {
                name: "on-brand-tone",
                value: true,
                reasoning: "Judges disagreed; escalation adjudicated.",
              },
            ],
          },
        },
        escalationCount: 1,
        skipCount: 0,
      },
      {
        caseId: "case-skipped",
        rubricKey: "tone-eval",
        input: { prompt: "hi again" },
        output: { text: "" },
        layers: {
          1: {
            status: "fail",
            checks: [{ name: "output-non-empty", value: false, reasoning: "empty" }],
          },
          3: {
            status: "skipped",
            checks: [],
            skippedReason: "Structurally meaningless without Layer 1.",
          },
        },
        escalationCount: 0,
        skipCount: 1,
      },
    ],
    rubricsUsed: {
      "tone-eval": {
        key: "tone-eval",
        contentHash: "abc123hash456",
        content: toneRubric,
      },
    },
    ...overrides,
  };
}

describe("renderGradingReportMarkdown", () => {
  it("matches the golden snapshot for a run with an escalation and a skip", () => {
    expectMatchesGolden("grading-report-mixed", renderGradingReportMarkdown(makeReport()));
  });

  it("matches the golden snapshot for a run with no Cases processed", () => {
    expectMatchesGolden(
      "grading-report-empty",
      renderGradingReportMarkdown(
        makeReport({
          casesProcessed: 0,
          tasksPassed: 0,
          tasksFailed: 0,
          tasksSkipped: 0,
          totalEscalations: 0,
          cases: [],
          rubricsUsed: {},
        }),
      ),
    );
  });
});
