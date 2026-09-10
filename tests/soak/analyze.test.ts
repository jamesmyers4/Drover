import { describe, expect, it } from "vitest";
import { GraderDb } from "../../src/grader/db.js";
import { runSoakAnalysis, SoakRunNotFoundError } from "../../src/soak/analyze.js";
import { ScriptedCrossTurnProvider } from "../../src/soak/cross-turn-provider.js";
import { newSoakId, SoakDb } from "../../src/soak/db.js";
import type {
  SoakBlueprint,
  SoakBlueprintConfigSnapshot,
  SoakRun,
  TurnRecord,
} from "../../src/soak/types.js";

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
    startedAt: Date.now(),
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
    requestPayload: { text: "Had a calm day." },
    responsePayload: { toneEval: "neutral" },
    responseTimeMs: 200,
    httpStatus: 200,
    explicitError: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeBlueprint(overrides: Partial<SoakBlueprint> = {}): SoakBlueprint {
  return {
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
    ...overrides,
  };
}

describe("runSoakAnalysis", () => {
  it("throws SoakRunNotFoundError for an unknown run id", async () => {
    const db = new SoakDb(":memory:");
    try {
      await expect(runSoakAnalysis({ db, runId: "does-not-exist" })).rejects.toBeInstanceOf(
        SoakRunNotFoundError,
      );
    } finally {
      db.close();
    }
  });

  it("runs the cross-turn pass and persists findings when no blueprint is given", async () => {
    const db = new SoakDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);
      db.insertTurn(makeTurn(run.id, { id: "t1" }));
      db.insertTurn(makeTurn(run.id, { id: "t2" }));

      const provider = new ScriptedCrossTurnProvider(
        [{ type: "drift", severity: "medium", description: "d", turnIds: ["t1", "t2"] }],
        0.01,
      );

      const result = await runSoakAnalysis({ db, runId: run.id, crossTurnProvider: provider });

      expect(result.turnsAnalyzed).toBe(2);
      expect(result.crossTurnFindingsWritten).toBe(1);
      expect(result.crossTurnFindingsSkipped).toBe(0);
      expect(result.crossTurnCostUsd).toBeCloseTo(0.01, 10);
      expect(result.grader).toBeUndefined();
      expect(result.graderSkippedReason).toMatch(/no blueprint supplied/);

      expect(db.getCrossTurnFindingsByRun(run.id)).toHaveLength(1);
      expect(db.getSoakRun(run.id)?.crossTurnCostUsd).toBeCloseTo(0.01, 10);
    } finally {
      db.close();
    }
  });

  it("skips the Grader pass with a specific reason when the blueprint has no graderIntegration", async () => {
    const db = new SoakDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);
      db.insertTurn(makeTurn(run.id));

      const result = await runSoakAnalysis({
        db,
        runId: run.id,
        blueprint: makeBlueprint(),
        crossTurnProvider: new ScriptedCrossTurnProvider([]),
      });

      expect(result.grader).toBeUndefined();
      expect(result.graderSkippedReason).toMatch(/no graderIntegration configured/);
    } finally {
      db.close();
    }
  });

  it("throws when graderIntegration is configured but no graderDb is supplied", async () => {
    const db = new SoakDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);
      db.insertTurn(makeTurn(run.id));

      const blueprint = makeBlueprint({
        graderIntegration: {
          rubrics: {
            "tone-eval": {
              key: "tone-eval",
              description: "d",
              checks: [{ name: "x", description: "d", scoringType: "boolean" }],
            },
          },
          rubricKeyFor: () => "tone-eval",
        },
      });

      await expect(
        runSoakAnalysis({
          db,
          runId: run.id,
          blueprint,
          crossTurnProvider: new ScriptedCrossTurnProvider([]),
        }),
      ).rejects.toThrow(/no graderDb was supplied/);
    } finally {
      db.close();
    }
  });

  it("runs a real, unmocked Layer-1-only Grader pass end to end and links the resulting GradingRun", async () => {
    const db = new SoakDb(":memory:");
    const graderDb = new GraderDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);
      const turn = makeTurn(run.id, {
        requestPayload: { text: "Had a calm day." },
        responsePayload: { toneEval: "neutral" },
      });
      db.insertTurn(turn);

      const blueprint = makeBlueprint({
        graderIntegration: {
          rubrics: {
            "tone-eval": {
              key: "tone-eval",
              description: "Scores tone.",
              checks: [{ name: "neutral-tone", description: "d", scoringType: "boolean" }],
            },
          },
          rubricKeyFor: () => "tone-eval",
          // Layer 1 (deterministic, no model call) is the only layer this
          // test needs — disabling 2/3 and forcing consensusJudges: [] via
          // an explicit `routing` override below keeps this test genuinely
          // $0/no-network regardless of what's installed in any given
          // environment, while still exercising the real runGrading() path,
          // not a mock of it.
          layers: { 2: { enabled: false }, 3: { enabled: false } },
        },
      });

      const result = await runSoakAnalysis({
        db,
        runId: run.id,
        blueprint,
        graderDb,
        routing: { singleJudge: { provider: "ollama", model: "unused" }, consensusJudges: [] },
        crossTurnProvider: new ScriptedCrossTurnProvider([]),
      });

      expect(result.grader).toBeDefined();
      if (result.grader === undefined) throw new Error("expected result.grader to be defined");
      expect(result.grader.casesProcessed).toBe(1);
      expect(result.grader.tasksPassed).toBeGreaterThan(0);
      expect(result.graderSkippedReason).toBeUndefined();

      const storedRun = db.getSoakRun(run.id);
      expect(storedRun?.gradingRunId).toBe(result.grader.gradingRunId);

      // Confirm the turn genuinely round-tripped through Grader's own real
      // schema, not just through runSoakAnalysis's own return value.
      const gradingRun = graderDb.getGradingRun(result.grader.gradingRunId);
      expect(gradingRun?.status).toBe("completed");
      const cases = graderDb.getCasesByGradingRun(result.grader.gradingRunId);
      expect(cases).toHaveLength(1);
      expect(cases[0]?.output).toEqual(turn.responsePayload);
    } finally {
      graderDb.close();
      db.close();
    }
  });

  it("accumulates cross-turn cost across repeated invocations", async () => {
    const db = new SoakDb(":memory:");
    try {
      const run = makeSoakRun();
      db.insertSoakRun(run);
      db.insertTurn(makeTurn(run.id));

      await runSoakAnalysis({
        db,
        runId: run.id,
        crossTurnProvider: new ScriptedCrossTurnProvider([], 0.01),
      });
      await runSoakAnalysis({
        db,
        runId: run.id,
        crossTurnProvider: new ScriptedCrossTurnProvider([], 0.02),
      });

      expect(db.getSoakRun(run.id)?.crossTurnCostUsd).toBeCloseTo(0.03, 10);
    } finally {
      db.close();
    }
  });
});
