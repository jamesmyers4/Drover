import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSoakId, SoakDb } from "../../src/soak/db.js";
import type {
  CrossTurnFindingRecord,
  MetricRecord,
  SoakBlueprintConfigSnapshot,
  SoakRun,
  TurnRecord,
} from "../../src/soak/types.js";

const sampleBlueprintConfig: SoakBlueprintConfigSnapshot = {
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
      name: "messageAnalysis",
      lane: "messageAnalysis",
      path: "/api/message-analysis/analyze",
      examples: ["Analyze this conversation for tone."],
    },
  ],
  pipelineBudgets: [{ pipeline: "messageAnalysis", maxCallsPerRun: 100 }],
  pacingMsRange: { minMs: 5000, maxMs: 60000 },
  budget: { ceilingUsd: 10 },
  maxDurationHours: 8,
};

function makeSoakRun(): SoakRun {
  return {
    id: newSoakId(),
    appName: "shenny",
    blueprintVersion: "2026-09-09.1",
    driverModel: "llama3.1:8b",
    targetBaseUrl: "https://staging.example.com",
    blueprintConfig: sampleBlueprintConfig,
    status: "running",
    budgetCeilingUsd: 10,
    spentUsd: 0,
    startedAt: Date.now(),
  };
}

function makeTurn(runId: string, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: newSoakId(),
    runId,
    sequence: 1,
    lane: "backbone",
    variationId: "entry-happy-path#0",
    requestPayload: { text: "Had a calm day, nothing much to report." },
    responsePayload: { toneEval: "neutral" },
    responseTimeMs: 245,
    httpStatus: 200,
    explicitError: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeMetric(runId: string, overrides: Partial<MetricRecord> = {}): MetricRecord {
  return {
    id: newSoakId(),
    runId,
    name: "backbone.responseTimeMs.p95",
    value: 312,
    recordedAt: Date.now(),
    ...overrides,
  };
}

function makeCrossTurnFinding(
  runId: string,
  overrides: Partial<CrossTurnFindingRecord> = {},
): CrossTurnFindingRecord {
  return {
    id: newSoakId(),
    runId,
    type: "disagreement",
    severity: "high",
    description: "Two turns disagree about the same synthetic record.",
    turnIds: ["turn-a", "turn-b"],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("SoakDb", () => {
  let db: SoakDb;

  beforeEach(() => {
    db = new SoakDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("migrates cleanly on an empty database", () => {
    const fresh = new SoakDb(":memory:");
    fresh.close();
  });

  it("round-trips a soak run, including the blueprint config snapshot", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    expect(db.getSoakRun(run.id)).toEqual(run);
  });

  it("getSoakRun returns undefined for an unknown id", () => {
    expect(db.getSoakRun(newSoakId())).toBeUndefined();
  });

  it("updateSoakRunStatus updates status and end time", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    const endedAt = Date.now();
    db.updateSoakRunStatus(run.id, "completed", endedAt);
    const updated = db.getSoakRun(run.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.endedAt).toBe(endedAt);
  });

  it("updateSoakRunStatus without an end time clears it", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    db.updateSoakRunStatus(run.id, "budget-stopped");
    expect(db.getSoakRun(run.id)?.endedAt).toBeUndefined();
  });

  it("updateSoakRunSpend overwrites the running total", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    db.updateSoakRunSpend(run.id, 4.5);
    expect(db.getSoakRun(run.id)?.spentUsd).toBe(4.5);
  });

  it("updateSoakRunGradingRunId links a Grader GradingRun id", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    db.updateSoakRunGradingRunId(run.id, "grading-run-1");
    expect(db.getSoakRun(run.id)?.gradingRunId).toBe("grading-run-1");
  });

  it("updateSoakRunGradingRunId overwrites rather than accumulates", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    db.updateSoakRunGradingRunId(run.id, "grading-run-1");
    db.updateSoakRunGradingRunId(run.id, "grading-run-2");
    expect(db.getSoakRun(run.id)?.gradingRunId).toBe("grading-run-2");
  });

  it("updateSoakRunCrossTurnCost accumulates across calls", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    db.updateSoakRunCrossTurnCost(run.id, 0.01);
    db.updateSoakRunCrossTurnCost(run.id, 0.02);
    expect(db.getSoakRun(run.id)?.crossTurnCostUsd).toBeCloseTo(0.03, 10);
  });

  it("a fresh run has no gradingRunId or crossTurnCostUsd", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    const stored = db.getSoakRun(run.id);
    expect(stored?.gradingRunId).toBeUndefined();
    expect(stored?.crossTurnCostUsd).toBeUndefined();
  });

  it("round-trips a backbone turn with a full response", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    const turn = makeTurn(run.id);
    db.insertTurn(turn);
    expect(db.getTurn(turn.id)).toEqual(turn);
  });

  it("round-trips a metered-pipeline turn recording an explicit error", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    const turn = makeTurn(run.id, {
      sequence: 2,
      lane: "messageAnalysis",
      variationId: "messageAnalysis#1",
      responsePayload: undefined,
      responseTimeMs: undefined,
      httpStatus: 500,
      explicitError: true,
      errorDetail: "connection reset",
    });
    db.insertTurn(turn);
    const stored = db.getTurn(turn.id);
    expect(stored).toEqual(turn);
    expect(stored?.responsePayload).toBeUndefined();
    expect(stored?.explicitError).toBe(true);
  });

  it("a 429 gating response is stored without explicitError set", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    const turn = makeTurn(run.id, {
      httpStatus: 429,
      responsePayload: { error: "rate limited" },
      explicitError: false,
    });
    db.insertTurn(turn);
    expect(db.getTurn(turn.id)?.explicitError).toBe(false);
  });

  it("getTurnsByRun returns a run's turns ordered by sequence", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    const t2 = makeTurn(run.id, { sequence: 2 });
    const t1 = makeTurn(run.id, { sequence: 1 });
    db.insertTurn(t2);
    db.insertTurn(t1);
    expect(db.getTurnsByRun(run.id).map((t) => t.id)).toEqual([t1.id, t2.id]);
  });

  it("getTurnsByRun scopes to the given run", () => {
    const runA = makeSoakRun();
    const runB = makeSoakRun();
    db.insertSoakRun(runA);
    db.insertSoakRun(runB);
    const turnA = makeTurn(runA.id);
    const turnB = makeTurn(runB.id);
    db.insertTurn(turnA);
    db.insertTurn(turnB);
    expect(db.getTurnsByRun(runA.id).map((t) => t.id)).toEqual([turnA.id]);
  });

  it("round-trips a metric", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    const metric = makeMetric(run.id);
    db.insertMetric(metric);
    expect(db.getMetricsByRun(run.id)).toEqual([metric]);
  });

  it("getMetricsByRun filters by name when given one", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    const p50 = makeMetric(run.id, { name: "backbone.responseTimeMs.p50", value: 180 });
    const p95 = makeMetric(run.id, { name: "backbone.responseTimeMs.p95", value: 312 });
    db.insertMetric(p50);
    db.insertMetric(p95);
    expect(db.getMetricsByRun(run.id, "backbone.responseTimeMs.p50")).toEqual([p50]);
    expect(db.getMetricsByRun(run.id)).toHaveLength(2);
  });

  it("round-trips a cross-turn finding", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    const finding = makeCrossTurnFinding(run.id);
    db.insertCrossTurnFinding(finding);
    expect(db.getCrossTurnFindingsByRun(run.id)).toEqual([finding]);
  });

  it("round-trips a timing-anomaly finding (no LLM-derived counterpart)", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    const finding = makeCrossTurnFinding(run.id, {
      type: "timing-anomaly",
      severity: "medium",
      description: 'Lane "backbone" shows a long response-time tail.',
      turnIds: ["slow-1"],
    });
    db.insertCrossTurnFinding(finding);
    expect(db.getCrossTurnFindingsByRun(run.id)).toEqual([finding]);
  });

  it("getCrossTurnFindingsByRun scopes to the given run and orders by created_at", () => {
    const runA = makeSoakRun();
    const runB = makeSoakRun();
    db.insertSoakRun(runA);
    db.insertSoakRun(runB);
    const f1 = makeCrossTurnFinding(runA.id, { createdAt: 1000 });
    const f2 = makeCrossTurnFinding(runA.id, { createdAt: 2000 });
    const fOther = makeCrossTurnFinding(runB.id);
    db.insertCrossTurnFinding(f2);
    db.insertCrossTurnFinding(f1);
    db.insertCrossTurnFinding(fOther);

    expect(db.getCrossTurnFindingsByRun(runA.id).map((f) => f.id)).toEqual([f1.id, f2.id]);
  });

  it("getCrossTurnFindingsByRun returns an empty array for a run with none", () => {
    const run = makeSoakRun();
    db.insertSoakRun(run);
    expect(db.getCrossTurnFindingsByRun(run.id)).toEqual([]);
  });
});
