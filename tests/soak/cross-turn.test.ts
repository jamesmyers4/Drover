import { describe, expect, it, vi } from "vitest";
import {
  detectTimingAnomalies,
  MIN_SAMPLES_FOR_TIMING_ANOMALY,
  runCrossTurnAnalysis,
  TIMING_ANOMALY_P99_TO_P50_RATIO,
} from "../../src/soak/cross-turn.js";
import type {
  CrossTurnProvider,
  CrossTurnResponse,
  RawCrossTurnFinding,
} from "../../src/soak/cross-turn-provider.js";
import { ScriptedCrossTurnProvider } from "../../src/soak/cross-turn-provider.js";
import { buildTurnDigest } from "../../src/soak/digest.js";
import type { TurnRecord } from "../../src/soak/types.js";
import { asFixture, type Loosen } from "../type-utils.js";

function makeTurn(overrides: Loosen<TurnRecord> = {}): TurnRecord {
  return asFixture<TurnRecord>({
    id: "turn-1",
    runId: "run-1",
    sequence: 1,
    lane: "backbone",
    variationId: "entry-happy-path#0",
    requestPayload: { text: "It was a quiet day." },
    responsePayload: { toneEval: "neutral" },
    responseTimeMs: 100,
    httpStatus: 200,
    explicitError: false,
    timestamp: 1700000000000,
    ...overrides,
  });
}

describe("runCrossTurnAnalysis — the planted cross-turn pattern (CTS.md Session 6 stop condition)", () => {
  it("surfaces a scripted-provider-detected disagreement between two turns about the same synthetic record", async () => {
    const turnA = makeTurn({
      id: "turn-a",
      requestPayload: { recordId: "entry-42", text: "Patient reported feeling much better today." },
      responsePayload: { toneEval: "positive" },
    });
    const turnB = makeTurn({
      id: "turn-b",
      sequence: 2,
      requestPayload: { recordId: "entry-42", text: "Patient reported feeling much better today." },
      responsePayload: { toneEval: "negative" },
    });

    const provider = new ScriptedCrossTurnProvider([
      {
        type: "disagreement",
        severity: "high",
        description:
          'Two turns referencing record "entry-42" produced contradictory toneEval verdicts (positive vs. negative) for the same reported content.',
        turnIds: ["turn-a", "turn-b"],
      },
    ]);

    const result = await runCrossTurnAnalysis({ turns: [turnA, turnB], provider });

    expect(result.turnsAnalyzed).toBe(2);
    const disagreement = result.findings.find((f) => f.type === "disagreement");
    expect(disagreement).toBeDefined();
    expect(disagreement?.turnIds).toEqual(["turn-a", "turn-b"]);
    expect(disagreement?.severity).toBe("high");
  });

  it("returns an empty result immediately for zero turns, without calling the provider", async () => {
    const analyze = vi.fn();
    const provider: CrossTurnProvider = { provider: "scripted", model: "scripted", analyze };

    const result = await runCrossTurnAnalysis({ turns: [], provider });

    expect(result).toEqual({
      turnsAnalyzed: 0,
      findings: [],
      findingsSkipped: 0,
      skippedReasons: [],
      costUsd: 0,
    });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("skips a malformed finding (unknown turn id) and logs a reason, without crashing the pass", async () => {
    const turn = makeTurn({ id: "turn-real" });
    const provider = new ScriptedCrossTurnProvider([
      {
        type: "drift",
        severity: "medium",
        description: "References a turn that doesn't exist in this batch.",
        turnIds: ["turn-does-not-exist"],
      } as RawCrossTurnFinding,
    ]);

    const result = await runCrossTurnAnalysis({ turns: [turn], provider });

    expect(result.findings).toHaveLength(0);
    expect(result.findingsSkipped).toBe(1);
    expect(result.skippedReasons[0]).toMatch(/turnIds.*contained no turn id/);
  });

  it("skips a finding with an invalid type", async () => {
    const turn = makeTurn();
    const provider = new ScriptedCrossTurnProvider([
      {
        type: "not-a-real-type",
        severity: "medium",
        description: "x",
        turnIds: [turn.id],
      } as unknown as RawCrossTurnFinding,
    ]);

    const result = await runCrossTurnAnalysis({ turns: [turn], provider });

    expect(result.findings).toHaveLength(0);
    expect(result.findingsSkipped).toBe(1);
  });

  it("dispatches one provider call per chunk and aggregates findings + cost across all of them", async () => {
    const turns = Array.from({ length: 5 }, (_, i) => makeTurn({ id: `t${i}`, sequence: i + 1 }));
    const responses: CrossTurnResponse[] = [
      {
        findings: [
          { type: "drift", severity: "low", description: "chunk 1 finding", turnIds: ["t0"] },
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.01,
        },
      },
      {
        findings: [
          {
            type: "recurring-error-cluster",
            severity: "high",
            description: "chunk 2 finding",
            turnIds: ["t3"],
          },
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.02,
        },
      },
    ];
    const analyze = vi.fn().mockResolvedValueOnce(responses[0]).mockResolvedValueOnce(responses[1]);
    const provider: CrossTurnProvider = { provider: "scripted", model: "scripted", analyze };

    const result = await runCrossTurnAnalysis({ turns, provider, turnsPerChunk: 3 });

    expect(analyze).toHaveBeenCalledTimes(2);
    expect(result.findings.map((f) => f.description)).toEqual(
      expect.arrayContaining(["chunk 1 finding", "chunk 2 finding"]),
    );
    expect(result.costUsd).toBeCloseTo(0.03, 10);
  });

  it("merges deterministic timing-anomaly findings even when the LLM pass reports nothing", async () => {
    const fastTurns = Array.from({ length: 5 }, (_, i) =>
      makeTurn({ id: `fast-${i}`, sequence: i + 1, responseTimeMs: 100 }),
    );
    const slowTurn = makeTurn({ id: "slow-1", sequence: 6, responseTimeMs: 1000 });
    const provider = new ScriptedCrossTurnProvider([]);

    const result = await runCrossTurnAnalysis({ turns: [...fastTurns, slowTurn], provider });

    const timing = result.findings.find((f) => f.type === "timing-anomaly");
    expect(timing).toBeDefined();
    expect(timing?.turnIds).toContain("slow-1");
  });
});

describe("detectTimingAnomalies", () => {
  function digestsWithTimes(lane: string, times: number[]) {
    return times.map((ms, i) =>
      buildTurnDigest(makeTurn({ id: `${lane}-${i}`, lane, responseTimeMs: ms })),
    );
  }

  it("flags a lane whose p99 is at least the configured ratio above its p50", () => {
    const times = [100, 100, 100, 100, 1000]; // p50=100, p99=1000 -> 10x
    const findings = detectTimingAnomalies(digestsWithTimes("backbone", times));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.type).toBe("timing-anomaly");
    expect(findings[0]?.description).toMatch(/backbone/);
  });

  it("does not flag a lane with a uniform response-time distribution", () => {
    const times = [100, 105, 98, 102, 101];
    expect(detectTimingAnomalies(digestsWithTimes("backbone", times))).toHaveLength(0);
  });

  it("does not flag a lane below the minimum sample threshold", () => {
    const times = Array(MIN_SAMPLES_FOR_TIMING_ANOMALY - 1).fill(100);
    times[0] = 100 * TIMING_ANOMALY_P99_TO_P50_RATIO * 10; // would trigger if sample size didn't gate it
    expect(detectTimingAnomalies(digestsWithTimes("backbone", times))).toHaveLength(0);
  });

  it("evaluates each lane independently", () => {
    const backbone = digestsWithTimes("backbone", [100, 100, 100, 100, 1000]);
    const messageAnalysis = digestsWithTimes("messageAnalysis", [200, 210, 195, 205, 198]);

    const findings = detectTimingAnomalies([...backbone, ...messageAnalysis]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toMatch(/backbone/);
  });

  it("excludes turns with no recorded response time from the sample set", () => {
    const withoutTime = buildTurnDigest(
      makeTurn({ id: "no-time", responseTimeMs: undefined, httpStatus: undefined }),
    );
    const timed = digestsWithTimes("backbone", [100, 105, 98, 102, 101]);
    expect(detectTimingAnomalies([withoutTime, ...timed])).toHaveLength(0);
  });
});
