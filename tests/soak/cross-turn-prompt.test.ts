import { describe, expect, it } from "vitest";
import {
  buildCrossTurnSystemPrompt,
  buildCrossTurnUserPrompt,
} from "../../src/soak/cross-turn-prompt.js";
import { buildTurnDigest } from "../../src/soak/digest.js";
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

describe("buildCrossTurnSystemPrompt", () => {
  it("names all three LLM-derived categories and defers timing to the deterministic pass", () => {
    const prompt = buildCrossTurnSystemPrompt();
    expect(prompt).toMatch(/disagreement/);
    expect(prompt).toMatch(/drift/);
    expect(prompt).toMatch(/recurring-error-cluster/);
    expect(prompt).toMatch(/Do not report a timing or performance observation/);
  });

  it("instructs an empty findings array rather than a forced finding", () => {
    expect(buildCrossTurnSystemPrompt()).toMatch(/do not force a finding/);
  });
});

describe("buildCrossTurnUserPrompt", () => {
  it("includes every digest's turn id and request/response content", () => {
    const digests = [
      buildTurnDigest(makeTurn({ id: "t1" })),
      buildTurnDigest(makeTurn({ id: "t2", requestPayload: { text: "Different day." } })),
    ];

    const prompt = buildCrossTurnUserPrompt(digests);

    expect(prompt).toContain("t1");
    expect(prompt).toContain("t2");
    expect(prompt).toContain("It was a quiet day.");
    expect(prompt).toContain("Different day.");
    expect(prompt).toContain("2 turn(s)");
  });

  it("renders (none) for a turn with no response", () => {
    const digest = buildTurnDigest(
      makeTurn({ responsePayload: undefined, httpStatus: undefined, responseTimeMs: undefined }),
    );
    expect(buildCrossTurnUserPrompt([digest])).toContain("response: (none)");
  });
});
