import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoakDb } from "../../src/soak/db.js";
import { runSoak } from "../../src/soak/scheduler.js";
import type { SoakBlueprint, SoakTeardownContext } from "../../src/soak/types.js";
import {
  SOAK_FIXTURE_FORCE_ERROR_MARKER,
  SOAK_FIXTURE_FORCE_GATE_MARKER,
  type SoakFixtureTarget,
  startSoakFixtureTarget,
} from "./fixture-target.js";

/** A fake clock: `sleep` never actually waits — it advances the simulated clock by exactly the requested amount and records the request, so pacing/duration logic runs against real numbers without real wall-clock delay. */
function makeFakeClock(startAt = 0) {
  let current = startAt;
  const sleepCalls: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      current += ms;
    },
    sleepCalls,
  };
}

/** Always selects index 0 — deterministic whenever a pool/example array has exactly one entry, which every test below uses unless it's specifically testing pool/example variety. */
const ZERO_RANDOM = () => 0;

function makeBlueprint(
  targetBaseUrl: string,
  overrides: Partial<SoakBlueprint> = {},
): SoakBlueprint {
  return {
    appName: "toy-fixture",
    version: "test",
    targetBaseUrl,
    dataPolicy: "synthetic-only",
    driverProvider: "ollama",
    driverModel: "llama3.1:8b",
    variationPools: [
      {
        name: "entry-happy-path",
        lane: "backbone",
        path: "/api/entries",
        examples: ["Had a calm day, nothing much to report."],
      },
    ],
    pipelineBudgets: [],
    pacingMsRange: { minMs: 1000, maxMs: 1000 },
    budget: { ceilingUsd: 1000 },
    maxDurationHours: 3000 / 3_600_000,
    ...overrides,
  };
}

describe("runSoak", () => {
  let db: SoakDb;
  let fixture: SoakFixtureTarget;

  beforeEach(async () => {
    db = new SoakDb(":memory:");
    fixture = await startSoakFixtureTarget();
  });

  afterEach(async () => {
    db.close();
    await fixture.close();
  });

  it("runs a full backbone-only soak run, recording every turn and respecting pacing within range", async () => {
    const clock = makeFakeClock();
    const blueprint = makeBlueprint(fixture.baseUrl, {
      pacingMsRange: { minMs: 5000, maxMs: 10000 },
      maxDurationHours: 60000 / 3_600_000,
    });

    const result = await runSoak({
      db,
      blueprint,
      now: clock.now,
      sleep: clock.sleep,
      random: Math.random,
    });

    expect(result.status).toBe("completed");
    expect(result.turnsDispatched).toBeGreaterThan(0);

    const turns = db.getTurnsByRun(result.runId);
    expect(turns).toHaveLength(result.turnsDispatched);
    for (const turn of turns) {
      expect(turn.lane).toBe("backbone");
      expect(turn.httpStatus).toBe(200);
      expect(turn.explicitError).toBe(false);
    }
    for (const delay of clock.sleepCalls) {
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThan(10000);
    }

    const storedRun = db.getSoakRun(result.runId);
    expect(storedRun?.status).toBe("completed");
  });

  it("stops the run gracefully once the budget ceiling is crossed", async () => {
    const clock = makeFakeClock();
    const blueprint = makeBlueprint(fixture.baseUrl, {
      budget: { ceilingUsd: 0.025, costPerCallUsd: 0.01 },
      maxDurationHours: 1000, // large enough that duration never ends the run first
    });

    const result = await runSoak({
      db,
      blueprint,
      now: clock.now,
      sleep: clock.sleep,
      random: ZERO_RANDOM,
    });

    expect(result.status).toBe("budget-stopped");
    expect(result.turnsDispatched).toBe(3);
    expect(result.spentUsd).toBeCloseTo(0.03, 6);

    const storedRun = db.getSoakRun(result.runId);
    expect(storedRun?.status).toBe("budget-stopped");
    expect(storedRun?.spentUsd).toBeCloseTo(0.03, 6);
    expect(db.getTurnsByRun(result.runId)).toHaveLength(3);
  });

  it("captures a forced explicit error on the turn without killing the run", async () => {
    const clock = makeFakeClock();
    const blueprint = makeBlueprint(fixture.baseUrl, {
      variationPools: [
        {
          name: "forced-error",
          lane: "backbone",
          path: "/api/entries",
          examples: [SOAK_FIXTURE_FORCE_ERROR_MARKER],
        },
      ],
      maxDurationHours: 3000 / 3_600_000,
    });

    const result = await runSoak({
      db,
      blueprint,
      now: clock.now,
      sleep: clock.sleep,
      random: ZERO_RANDOM,
    });

    expect(result.status).toBe("completed");
    expect(result.turnsDispatched).toBe(3);
    expect(result.explicitErrorCount).toBe(3);

    const turns = db.getTurnsByRun(result.runId);
    expect(turns).toHaveLength(3);
    for (const turn of turns) {
      expect(turn.httpStatus).toBe(500);
      expect(turn.explicitError).toBe(true);
      expect(turn.errorDetail).toBe("HTTP 500");
    }
  });

  it("treats a 429/402 gating response as expected, not an explicit error", async () => {
    const clock = makeFakeClock();
    const blueprint = makeBlueprint(fixture.baseUrl, {
      variationPools: [
        {
          name: "forced-gate",
          lane: "backbone",
          path: "/api/entries",
          examples: [SOAK_FIXTURE_FORCE_GATE_MARKER],
        },
      ],
      maxDurationHours: 2000 / 3_600_000,
    });

    const result = await runSoak({
      db,
      blueprint,
      now: clock.now,
      sleep: clock.sleep,
      random: ZERO_RANDOM,
    });

    expect(result.turnsDispatched).toBe(2);
    expect(result.explicitErrorCount).toBe(0);
    expect(result.gatedResponseCount).toBe(2);

    for (const turn of db.getTurnsByRun(result.runId)) {
      expect(turn.httpStatus).toBe(429);
      expect(turn.explicitError).toBe(false);
    }
  });

  it("reads a real cost figure from the target's response header over the configured per-call estimate", async () => {
    await fixture.close();
    fixture = await startSoakFixtureTarget({ costHeaderUsd: 0.02 });

    const clock = makeFakeClock();
    const blueprint = makeBlueprint(fixture.baseUrl, {
      budget: { ceilingUsd: 1000, costPerCallUsd: 999 },
      maxDurationHours: 2000 / 3_600_000,
    });

    const result = await runSoak({
      db,
      blueprint,
      now: clock.now,
      sleep: clock.sleep,
      random: ZERO_RANDOM,
    });

    expect(result.turnsDispatched).toBe(2);
    expect(result.spentUsd).toBeCloseTo(0.04, 6);
  });

  it("runs the metered-pipeline lane, capping at maxCallsPerRun and pacing by spreading across maxDurationHours", async () => {
    const clock = makeFakeClock();
    const blueprint = makeBlueprint(fixture.baseUrl, {
      variationPools: [
        {
          name: "message-analysis-standard",
          lane: "messageAnalysis",
          path: "/api/message-analysis/analyze",
          examples: ["Analyze this conversation for tone."],
        },
      ],
      pipelineBudgets: [{ pipeline: "messageAnalysis", maxCallsPerRun: 4 }],
      maxDurationHours: 4000 / 3_600_000,
    });

    const result = await runSoak({
      db,
      blueprint,
      now: clock.now,
      sleep: clock.sleep,
      random: ZERO_RANDOM,
    });

    expect(result.status).toBe("completed");
    expect(result.turnsDispatched).toBe(4);
    // 3 inter-turn sleeps for 4 calls (no trailing sleep after the last one),
    // each ~= maxDurationMs / maxCallsPerRun = 4000 / 4 = 1000ms.
    expect(clock.sleepCalls).toEqual([1000, 1000, 1000]);

    const turns = db.getTurnsByRun(result.runId);
    expect(turns).toHaveLength(4);
    for (const turn of turns) {
      expect(turn.lane).toBe("messageAnalysis");
    }
  });

  it("calls teardown exactly once at run end with the run's own context", async () => {
    const clock = makeFakeClock();
    const teardown = vi.fn(async (_ctx: SoakTeardownContext) => {});
    const blueprint = makeBlueprint(fixture.baseUrl, {
      maxDurationHours: 2000 / 3_600_000,
      teardown,
    });

    const result = await runSoak({
      db,
      blueprint,
      now: clock.now,
      sleep: clock.sleep,
      random: ZERO_RANDOM,
    });

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledWith({
      runId: result.runId,
      targetBaseUrl: fixture.baseUrl,
      runStartedAt: 0,
      runEndedAt: clock.now(),
    });
  });

  it("sends the configured bearer token as an Authorization header, never in the request payload", async () => {
    const clock = makeFakeClock();
    const blueprint = makeBlueprint(fixture.baseUrl, { maxDurationHours: 1000 / 3_600_000 });

    await runSoak({
      db,
      blueprint,
      now: clock.now,
      sleep: clock.sleep,
      random: ZERO_RANDOM,
      authToken: "test-token",
    });

    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.authorization).toBe("Bearer test-token");
    expect(JSON.stringify(fixture.requests[0]?.body)).not.toContain("test-token");
  });
});
