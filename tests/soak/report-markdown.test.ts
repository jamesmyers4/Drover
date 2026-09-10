import { describe, it } from "vitest";
import type { SoakReport } from "../../src/soak/report.js";
import { renderSoakReportMarkdown } from "../../src/soak/report-markdown.js";
import { expectMatchesGolden } from "../golden/golden-file.js";

function makeReport(overrides?: Partial<SoakReport>): SoakReport {
  return {
    runId: "run-1",
    appName: "toy-fixture",
    status: "completed",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    budgetCeilingUsd: 10,
    spentUsd: 3.2145,
    crossTurnCostUsd: 0.015,
    turnsByLane: [
      { lane: "backbone", count: 40, explicitErrorCount: 2, gatedCount: 1 },
      { lane: "messageAnalysis", count: 8, explicitErrorCount: 0, gatedCount: 3 },
    ],
    explicitErrorClusters: [
      { errorDetail: "HTTP 500", count: 2, turnIds: ["t1", "t2"] },
      { errorDetail: "connection reset", count: 1, turnIds: ["t9"] },
    ],
    crossTurnFindings: [
      {
        id: "f1",
        runId: "run-1",
        type: "disagreement",
        severity: "high",
        description: 'Two turns referencing record "entry-42" produced contradictory verdicts.',
        turnIds: ["t3", "t4"],
        createdAt: 1_700_000_030_000,
      },
      {
        id: "f2",
        runId: "run-1",
        type: "timing-anomaly",
        severity: "medium",
        description: 'Lane "backbone" shows a long response-time tail.',
        turnIds: ["t5"],
        createdAt: 1_700_000_031_000,
      },
    ],
    ...overrides,
  };
}

describe("renderSoakReportMarkdown", () => {
  it("matches the golden snapshot for a full report with a linked Grader pass", () => {
    const report = makeReport({
      graderReportMarkdown: "# Grading Report — toy-fixture\n\nGrading Run `gr-1` — **completed**",
    });
    expectMatchesGolden("soak-report-full", renderSoakReportMarkdown(report));
  });

  it("matches the golden snapshot when the Grader pass was never run", () => {
    const report = makeReport();
    expectMatchesGolden("soak-report-no-grader-pass", renderSoakReportMarkdown(report));
  });

  it("matches the golden snapshot when a linked Grader pass couldn't be read", () => {
    const report = makeReport({
      graderUnavailableReason: 'linked GradingRun "gr-1" was not found in the supplied graderDb',
    });
    expectMatchesGolden("soak-report-grader-unavailable", renderSoakReportMarkdown(report));
  });

  it("matches the golden snapshot for a minimal, empty-activity run", () => {
    const report: SoakReport = {
      runId: "run-2",
      appName: "toy-fixture",
      status: "running",
      startedAt: 1_700_000_000_000,
      budgetCeilingUsd: 10,
      spentUsd: 0,
      turnsByLane: [],
      explicitErrorClusters: [],
      crossTurnFindings: [],
    };
    expectMatchesGolden("soak-report-empty", renderSoakReportMarkdown(report));
  });
});
