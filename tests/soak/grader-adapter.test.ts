import { describe, expect, it } from "vitest";
import { validateGraderPack } from "../../src/grader/pack-validation.js";
import type { GraderPack } from "../../src/grader/types.js";
import { turnToCase } from "../../src/soak/grader-adapter.js";
import type { TurnRecord } from "../../src/soak/types.js";

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    runId: "run-1",
    sequence: 1,
    lane: "backbone",
    variationId: "entry-happy-path#0",
    requestPayload: { text: "It was a quiet day." },
    responsePayload: { toneEval: "neutral", entrySplit: ["It was a quiet day."] },
    responseTimeMs: 245,
    httpStatus: 200,
    explicitError: false,
    timestamp: 1700000000000,
    ...overrides,
  };
}

describe("turnToCase", () => {
  it("maps a turn's response into output and calls rubricKeyFor with the turn", () => {
    const turn = makeTurn();
    const rubricKeyFor = (t: TurnRecord) => (t.lane === "backbone" ? "tone-eval" : "unknown");

    const caseInput = turnToCase(turn, rubricKeyFor);

    expect(caseInput.output).toEqual(turn.responsePayload);
    expect(caseInput.rubric).toBe("tone-eval");
  });

  it("wraps requestPayload alone when no context is given", () => {
    const turn = makeTurn();
    const caseInput = turnToCase(turn, () => "tone-eval");
    expect(caseInput.input).toEqual({ requestPayload: turn.requestPayload });
  });

  it("threads caller-supplied context alongside requestPayload when given", () => {
    const turn = makeTurn();
    const sourceEntries = ["entry one", "entry two"];

    const caseInput = turnToCase(turn, () => "insight-report", sourceEntries);

    expect(caseInput.input).toEqual({
      requestPayload: turn.requestPayload,
      context: sourceEntries,
    });
  });

  it("is target-agnostic — rubricKeyFor is the only place any target-specific logic can live", () => {
    const turn = makeTurn({ lane: "messageAnalysis" });
    const rubricKeyFor = (t: TurnRecord) => `${t.lane}-rubric`;

    expect(turnToCase(turn, rubricKeyFor).rubric).toBe("messageAnalysis-rubric");
  });

  it("round-trips through Grader's real validateGraderPack — a valid CaseInput Grader's own schema accepts, not a duplicated shadow schema", async () => {
    const turn = makeTurn();
    const expectedCase = turnToCase(turn, () => "tone-eval");

    const pack: GraderPack = {
      appName: "soak-adapter-test",
      rubrics: {
        "tone-eval": {
          key: "tone-eval",
          description: "Scores whether the response reads as neutral in tone.",
          checks: [
            {
              name: "neutral-tone",
              description: "Reads as neutral, not alarmed.",
              scoringType: "boolean",
            },
          ],
        },
      },
      loadCases: () => [expectedCase],
      dataPolicy: "synthetic-only",
    };

    const cases = await validateGraderPack(pack);

    expect(cases).toHaveLength(1);
    expect(cases[0]).toEqual(expectedCase);
  });

  it("fails Grader's real validateGraderPack when rubricKeyFor returns an undeclared rubric key", async () => {
    const turn = makeTurn();
    const pack: GraderPack = {
      appName: "soak-adapter-test",
      rubrics: {},
      loadCases: () => [turnToCase(turn, () => "does-not-exist")],
      dataPolicy: "synthetic-only",
    };

    await expect(validateGraderPack(pack)).rejects.toThrow(/does-not-exist/);
  });
});
