import { describe, expect, it } from "vitest";
import { GraderDb, newGraderId } from "../../src/grader/db.js";
import type { Case, GraderPackConfigSnapshot, GradingRun } from "../../src/grader/types.js";
import { newSoakId, SoakDb } from "../../src/soak/db.js";
import { buildSoakReport, SoakReportRunNotFoundError } from "../../src/soak/report.js";
import type { SoakBlueprintConfigSnapshot, SoakRun, TurnRecord } from "../../src/soak/types.js";

const sampleBlueprintConfig: SoakBlueprintConfigSnapshot = {
  appName: "toy-fixture",
  version: "test",
  targetBaseUrl: "http://127.0.0.1:0",
  dataPolicy: "synthetic-only",
  driverProvider: "ollama",
  driverModel: "llama3.1:8b",
  variationPools: [
    { name: "entry-happy-path", lane: "backbone", path: "/api/entries", examples: ["x"] },
  ],
  pipelineBudgets: [],
  pacingMsRange: { minMs: 1000, maxMs: 1000 },
  budget: { ceilingUsd: 10 },
  maxDurationHours: 1,
};

function makeSoakRun(overrides: Partial<SoakRun> = {}): SoakRun {
  return {
    id: newSoakId(),
    appName: "toy-fixture",
    blueprintVersion: "test",
    driverModel: "llama3.1:8b",
    targetBaseUrl: "http://127.0.0.1:0",
    blueprintConfig: sampleBlueprintConfig,
    status: "completed",
    budgetCeilingUsd: 10,
    spentUsd: 0.05,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    ...overrides,
  };
}

function makeTurn(runId: string, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: newSoakId(),
    runId,
    sequence: 1,
    lane: "backbone",
    variationId: "entry-happy-path#0",
    requestPayload: { text: "x" },
    responsePayload: { ok: true },
    responseTimeMs: 200,
    httpStatus: 200,
    explicitError: false,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("buildSoakReport", () => {
  it("throws SoakReportRunNotFoundError for an unknown run id", () => {
    const db = new SoakDb(":memory:");
    try {
      expect(() => buildSoakReport(db, "does-not-exist")).toThrow(SoakReportRunNotFoundError);
    } finally {
      db.close();
    }
  });

  it("groups turn volume by lane, counting explicit errors and gated responses separately", () => {
    const db = new SoakDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);
      db.insertTurn(makeTurn(run.id, { lane: "backbone", httpStatus: 200 }));
      db.insertTurn(makeTurn(run.id, { lane: "backbone", httpStatus: 429 }));
      db.insertTurn(
        makeTurn(run.id, {
          lane: "messageAnalysis",
          httpStatus: 500,
          explicitError: true,
          errorDetail: "HTTP 500",
        }),
      );

      const report = buildSoakReport(db, run.id);

      expect(report.turnsByLane).toEqual([
        { lane: "backbone", count: 2, explicitErrorCount: 0, gatedCount: 1 },
        { lane: "messageAnalysis", count: 1, explicitErrorCount: 1, gatedCount: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it("groups explicit errors by errorDetail, most frequent first", () => {
    const db = new SoakDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);
      db.insertTurn(makeTurn(run.id, { id: "t1", explicitError: true, errorDetail: "HTTP 500" }));
      db.insertTurn(makeTurn(run.id, { id: "t2", explicitError: true, errorDetail: "HTTP 500" }));
      db.insertTurn(
        makeTurn(run.id, { id: "t3", explicitError: true, errorDetail: "connection reset" }),
      );

      const report = buildSoakReport(db, run.id);

      expect(report.explicitErrorClusters).toEqual([
        { errorDetail: "HTTP 500", count: 2, turnIds: ["t1", "t2"] },
        { errorDetail: "connection reset", count: 1, turnIds: ["t3"] },
      ]);
    } finally {
      db.close();
    }
  });

  it("includes persisted cross-turn findings", () => {
    const db = new SoakDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);
      db.insertCrossTurnFinding({
        id: newSoakId(),
        runId: run.id,
        type: "drift",
        severity: "medium",
        description: "d",
        turnIds: ["t1"],
        createdAt: Date.now(),
      });

      expect(buildSoakReport(db, run.id).crossTurnFindings).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("has no grader section fields when the run has no linked GradingRun", () => {
    const db = new SoakDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);

      const report = buildSoakReport(db, run.id);

      expect(report.graderReportMarkdown).toBeUndefined();
      expect(report.graderUnavailableReason).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("marks the grader pass unavailable when a gradingRunId is linked but no graderDb is supplied", () => {
    const db = new SoakDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);
      db.updateSoakRunGradingRunId(run.id, "grading-run-1");

      const report = buildSoakReport(db, run.id);

      expect(report.graderReportMarkdown).toBeUndefined();
      expect(report.graderUnavailableReason).toMatch(/no graderDb was supplied/);
    } finally {
      db.close();
    }
  });

  it("marks the grader pass unavailable when the linked GradingRun isn't in the supplied graderDb", () => {
    const db = new SoakDb(":memory:");
    const graderDb = new GraderDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);
      db.updateSoakRunGradingRunId(run.id, "does-not-exist");

      const report = buildSoakReport(db, run.id, graderDb);

      expect(report.graderReportMarkdown).toBeUndefined();
      expect(report.graderUnavailableReason).toMatch(/was not found/);
    } finally {
      graderDb.close();
      db.close();
    }
  });

  it("embeds the real rendered Grading report when the linked GradingRun exists in graderDb", () => {
    const db = new SoakDb(":memory:");
    const graderDb = new GraderDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);

      const gradingRunId = newGraderId();
      const packConfig: GraderPackConfigSnapshot = {
        appName: "toy-fixture",
        rubrics: {},
        dataPolicy: "synthetic-only",
      };
      const gradingRun: GradingRun = {
        id: gradingRunId,
        appName: "toy-fixture",
        packConfig,
        status: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
      };
      graderDb.insertGradingRun(gradingRun);
      const gradingCase: Case = {
        id: newGraderId(),
        gradingRunId,
        input: { text: "x" },
        output: { ok: true },
        rubric: "tone-eval",
        createdAt: Date.now(),
      };
      graderDb.insertCase(gradingCase);
      db.updateSoakRunGradingRunId(run.id, gradingRunId);

      const report = buildSoakReport(db, run.id, graderDb);

      expect(report.graderUnavailableReason).toBeUndefined();
      expect(report.graderReportMarkdown).toBeDefined();
      expect(report.graderReportMarkdown).toMatch(/Grading Run/i);
    } finally {
      graderDb.close();
      db.close();
    }
  });
});
