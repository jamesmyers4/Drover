import { describe, expect, it } from "vitest";
import { buildTurnDigest, chunkArray } from "../../src/soak/digest.js";
import type { TurnRecord } from "../../src/soak/types.js";

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    runId: "run-1",
    sequence: 1,
    lane: "backbone",
    variationId: "entry-happy-path#0",
    requestPayload: { text: "It was a quiet day." },
    responsePayload: { toneEval: "neutral" },
    responseTimeMs: 245,
    httpStatus: 200,
    explicitError: false,
    timestamp: 1700000000000,
    ...overrides,
  };
}

describe("buildTurnDigest", () => {
  it("maps every field from the turn directly", () => {
    const turn = makeTurn();
    const digest = buildTurnDigest(turn);

    expect(digest.turnId).toBe(turn.id);
    expect(digest.sequence).toBe(turn.sequence);
    expect(digest.lane).toBe(turn.lane);
    expect(digest.variationId).toBe(turn.variationId);
    expect(digest.timestamp).toBe(turn.timestamp);
    expect(digest.responseTimeMs).toBe(turn.responseTimeMs);
    expect(digest.httpStatus).toBe(turn.httpStatus);
    expect(digest.explicitError).toBe(false);
    expect(digest.requestSummary).toBe(JSON.stringify(turn.requestPayload));
    expect(digest.responseSummary).toBe(JSON.stringify(turn.responsePayload));
  });

  it("omits responseSummary when there was no response (e.g. a variation-failed turn)", () => {
    const turn = makeTurn({
      responsePayload: undefined,
      httpStatus: undefined,
      responseTimeMs: undefined,
      explicitError: true,
      errorDetail: "variation failed: script exhausted",
    });

    const digest = buildTurnDigest(turn);

    expect(digest.responseSummary).toBeUndefined();
    expect(digest.httpStatus).toBeUndefined();
    expect(digest.explicitError).toBe(true);
    expect(digest.errorDetail).toBe("variation failed: script exhausted");
  });

  it("truncates an oversized payload rather than embedding it whole", () => {
    const hugeText = "x".repeat(5000);
    const turn = makeTurn({ requestPayload: { text: hugeText } });

    const digest = buildTurnDigest(turn);

    expect(digest.requestSummary.length).toBeLessThan(JSON.stringify(turn.requestPayload).length);
    expect(digest.requestSummary.endsWith("…")).toBe(true);
  });

  it("defaults explicitError to false when the turn field is undefined", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately constructing a pre-migration-shaped record
    const turn = makeTurn({ explicitError: undefined as any });
    expect(buildTurnDigest(turn).explicitError).toBe(false);
  });
});

describe("chunkArray", () => {
  it("splits into groups of the given size, last group possibly smaller", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one chunk when size exceeds the array length", () => {
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("returns an empty array for an empty input", () => {
    expect(chunkArray([], 10)).toEqual([]);
  });

  it("throws for a non-positive size", () => {
    expect(() => chunkArray([1, 2], 0)).toThrow(/turnsPerChunk must be a positive number/);
    expect(() => chunkArray([1, 2], -1)).toThrow(/turnsPerChunk must be a positive number/);
  });
});
