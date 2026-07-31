import { describe, expect, it } from "vitest";
import { resolveRubric, snapshotRubric, UnknownRubricError } from "../../src/grader/rubric.js";
import type { GraderPack, Rubric } from "../../src/grader/types.js";

const toneRubric: Rubric = {
  key: "tone-eval",
  description: "Scores tone.",
  checks: [
    { name: "on-brand-tone", description: "Reads as warm.", scoringType: "boolean" },
    {
      name: "quality-score",
      description: "1-5 quality.",
      scoringType: "numeric",
      numericTolerance: 0.5,
      passThreshold: { comparison: "gte", value: 3 },
    },
  ],
};

function makePack(overrides?: Partial<GraderPack>): GraderPack {
  return {
    appName: "toy-app",
    rubrics: { "tone-eval": toneRubric },
    loadCases: () => [],
    dataPolicy: "synthetic-only",
    ...overrides,
  };
}

describe("resolveRubric", () => {
  it("resolves a known rubric key", () => {
    expect(resolveRubric(makePack(), "tone-eval")).toEqual(toneRubric);
  });

  it("throws UnknownRubricError for an unresolvable key", () => {
    expect(() => resolveRubric(makePack(), "typo-eval")).toThrow(UnknownRubricError);
  });
});

describe("snapshotRubric", () => {
  it("carries the rubric's key and full content", () => {
    const snapshot = snapshotRubric(toneRubric);
    expect(snapshot.key).toBe("tone-eval");
    expect(snapshot.content).toEqual(toneRubric);
  });

  it("is deterministic for the same rubric content", () => {
    const a = snapshotRubric(toneRubric);
    const b = snapshotRubric({ ...toneRubric });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("changes hash when a Check's description changes but not its name/scoringType", () => {
    const changed: Rubric = {
      ...toneRubric,
      checks: [
        {
          ...toneRubric.checks[0],
          description: "A materially different description.",
        } as Rubric["checks"][number],
        toneRubric.checks[1],
      ],
    };
    expect(snapshotRubric(changed).contentHash).not.toBe(snapshotRubric(toneRubric).contentHash);
  });

  it("changes hash when a numeric Check's passThreshold changes but numericTolerance doesn't", () => {
    const changed: Rubric = {
      ...toneRubric,
      checks: [
        toneRubric.checks[0],
        {
          ...toneRubric.checks[1],
          passThreshold: { comparison: "gte", value: 4 },
        } as Rubric["checks"][number],
      ],
    };
    expect(snapshotRubric(changed).contentHash).not.toBe(snapshotRubric(toneRubric).contentHash);
  });

  it("produces the same hash regardless of the rubric object's own key insertion order", () => {
    const reordered: Rubric = {
      description: toneRubric.description,
      key: toneRubric.key,
      checks: toneRubric.checks,
    };
    expect(snapshotRubric(reordered).contentHash).toBe(snapshotRubric(toneRubric).contentHash);
  });
});
