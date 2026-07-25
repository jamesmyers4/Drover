import { describe, it } from "vitest";
import { renderMarkdownReport } from "../../src/report/markdown.js";
import type { RunReport } from "../../src/report/report.js";
import { expectMatchesGolden } from "../golden/golden-file.js";

function makeReport(overrides?: Partial<RunReport>): RunReport {
  return {
    runId: "run-1",
    appName: "horse-haven-ops",
    status: "completed",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    runDimensions: { orgSize: 5, simulatedWeeks: 2, sessionsPerPersonaPerWeek: 3 },
    budget: { runCeilingUsd: 10, perSessionSoftCapUsd: 0.5, analystCeilingUsd: 1 },
    actorCostUsd: 1.2345,
    analystCostUsd: 0.05,
    hasAnalystPass: true,
    reconciliation: { new: 1, stillOpen: 2, resolved: 1 },
    findings: [
      {
        matchKey: "http-failure:/api/schedule:POST",
        type: "http-failure",
        severity: "high",
        description: "POST /api/schedule returned 500",
        sessionIds: ["s1", "s2"],
        goalIds: ["schedule-edit"],
        status: "still-open",
        evidence: { screenshotPath: "shots/s1.png", eventIds: ["e1", "e2"] },
      },
      {
        matchKey: "recurring-dead-end:/help",
        type: "recurring-dead-end",
        severity: "medium",
        description: "Both personas dead-end on /help",
        sessionIds: ["s1", "s3"],
        goalIds: ["check-in", "schedule-edit"],
        status: "new",
        evidence: { eventIds: [] },
      },
    ],
    findingsByFlow: {
      "schedule-edit": [],
      "check-in": [],
    },
    ...overrides,
  };
}

describe("renderMarkdownReport", () => {
  it("matches the golden snapshot for a run with mixed findings", () => {
    const findings = makeReport().findings;
    const report = makeReport({
      findingsByFlow: {
        "schedule-edit": [findings[0], findings[1]] as RunReport["findings"],
        "check-in": [findings[1]] as RunReport["findings"],
      },
    });
    expectMatchesGolden("report-mixed-findings", renderMarkdownReport(report));
  });

  it("matches the golden snapshot for a run with no findings and no analyst pass", () => {
    const report = makeReport({
      analystCostUsd: undefined,
      hasAnalystPass: false,
      reconciliation: { new: 0, stillOpen: 0, resolved: 0 },
      findings: [],
      findingsByFlow: {},
      endedAt: undefined,
      status: "running",
    });
    expectMatchesGolden("report-empty", renderMarkdownReport(report));
  });
});
