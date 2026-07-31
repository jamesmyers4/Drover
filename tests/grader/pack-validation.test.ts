import { describe, expect, it } from "vitest";
import { GraderPackValidationError, validateGraderPack } from "../../src/grader/pack-validation.js";
import type { GraderPack, Rubric } from "../../src/grader/types.js";

const toneRubric: Rubric = {
  key: "tone-eval",
  description: "Scores whether generated copy matches the target tone.",
  checks: [
    { name: "on-brand-tone", description: "Reads as warm, not clinical.", scoringType: "boolean" },
  ],
};

function makeValidPack(overrides?: Partial<GraderPack>): GraderPack {
  return {
    appName: "shenny",
    rubrics: { "tone-eval": toneRubric },
    loadCases: () => [{ input: { prompt: "hi" }, output: { text: "hello!" }, rubric: "tone-eval" }],
    dataPolicy: "restricted",
    ...overrides,
  };
}

async function expectIssueCodes(pack: GraderPack, expectedCodes: string[]): Promise<void> {
  await expect(validateGraderPack(pack)).rejects.toSatisfy((err: unknown) => {
    expect(err).toBeInstanceOf(GraderPackValidationError);
    const issue = err as GraderPackValidationError;
    expect(issue.issues.map((i) => i.code).sort()).toEqual(expectedCodes.sort());
    return true;
  });
}

describe("validateGraderPack", () => {
  it("passes a well-formed pack with no layers override, and returns the loaded Cases", async () => {
    await expect(validateGraderPack(makeValidPack())).resolves.toEqual([
      { input: { prompt: "hi" }, output: { text: "hello!" }, rubric: "tone-eval" },
    ]);
  });

  it("passes a well-formed pack with a valid, acyclic prerequisite declaration", async () => {
    const pack = makeValidPack({
      layers: {
        5: {
          requires: [
            {
              layerId: 3,
              justification:
                "Structurally meaningless without a grounded output to check faithfulness against.",
            },
          ],
        },
      },
    });
    await expect(validateGraderPack(pack)).resolves.toEqual(expect.any(Array));
  });

  it("fails with unknown-rubric when a Case references a rubric key not declared in GraderPack.rubrics (typo)", async () => {
    const pack = makeValidPack({
      loadCases: () => [
        { input: { prompt: "hi" }, output: { text: "hello!" }, rubric: "tone-evall" },
      ],
    });
    await expectIssueCodes(pack, ["unknown-rubric"]);
    try {
      await validateGraderPack(pack);
    } catch (err) {
      expect(err).toBeInstanceOf(GraderPackValidationError);
      expect((err as GraderPackValidationError).message).toContain("tone-evall");
      expect((err as GraderPackValidationError).issues[0]?.message).toContain("tone-eval");
    }
  });

  it("reports every unresolved rubric key once, not once per offending Case", async () => {
    const pack = makeValidPack({
      loadCases: () => [
        { input: {}, output: {}, rubric: "nope" },
        { input: {}, output: {}, rubric: "nope" },
      ],
    });
    await expect(validateGraderPack(pack)).rejects.toSatisfy((err: unknown) => {
      const issue = err as GraderPackValidationError;
      expect(issue.issues.filter((i) => i.code === "unknown-rubric")).toHaveLength(1);
      return true;
    });
  });

  it("fails with malformed-layers when layers is not an object", async () => {
    const pack = makeValidPack({
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the validator
      layers: "not-an-object" as any,
    });
    await expectIssueCodes(pack, ["malformed-layers"]);
  });

  it("fails with malformed-layers when a layer key is out of the 1-7 range", async () => {
    const pack = makeValidPack({
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the validator
      layers: { 9: { enabled: true } } as any,
    });
    await expectIssueCodes(pack, ["malformed-layers"]);
  });

  it("fails with malformed-layers when .enabled is the wrong type", async () => {
    const pack = makeValidPack({
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the validator
      layers: { 2: { enabled: "yes" } } as any,
    });
    await expectIssueCodes(pack, ["malformed-layers"]);
  });

  it("fails with malformed-layers when a declared prerequisite is missing its justification string", async () => {
    const pack = makeValidPack({
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the validator
      layers: { 5: { requires: [{ layerId: 3 }] } } as any,
    });
    await expectIssueCodes(pack, ["malformed-layers"]);
  });

  it("fails with malformed-layers when a declared prerequisite's layerId is out of range", async () => {
    const pack = makeValidPack({
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the validator
      layers: { 5: { requires: [{ layerId: 99, justification: "because" }] } } as any,
    });
    await expectIssueCodes(pack, ["malformed-layers"]);
  });

  it("fails with cyclic-prerequisite when the declared prerequisite DAG has a cycle", async () => {
    const pack = makeValidPack({
      layers: {
        2: { requires: [{ layerId: 3, justification: "meaningless without layer 3" }] },
        3: { requires: [{ layerId: 2, justification: "meaningless without layer 2" }] },
      },
    });
    await expectIssueCodes(pack, ["cyclic-prerequisite"]);
    try {
      await validateGraderPack(pack);
    } catch (err) {
      expect((err as GraderPackValidationError).issues[0]?.message).toMatch(
        /2 -> 3 -> 2|3 -> 2 -> 3/,
      );
    }
  });

  it("does not run cycle detection over an already-malformed layers map (avoids a redundant, confusing second error)", async () => {
    const pack = makeValidPack({
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the validator
      layers: "not-an-object" as any,
    });
    await expectIssueCodes(pack, ["malformed-layers"]);
  });

  it("collects issues from multiple independent problems in a single pass", async () => {
    const pack = makeValidPack({
      loadCases: () => [{ input: {}, output: {}, rubric: "nope" }],
      layers: {
        2: { requires: [{ layerId: 3, justification: "x" }] },
        3: { requires: [{ layerId: 2, justification: "y" }] },
      },
    });
    await expectIssueCodes(pack, ["unknown-rubric", "cyclic-prerequisite"]);
  });

  it("fails with cases-load-failed when loadCases() throws, rather than an unhandled rejection", async () => {
    const pack = makeValidPack({
      loadCases: () => {
        throw new Error("database unreachable");
      },
    });
    await expectIssueCodes(pack, ["cases-load-failed"]);
    try {
      await validateGraderPack(pack);
    } catch (err) {
      expect((err as GraderPackValidationError).issues[0]?.message).toContain(
        "database unreachable",
      );
    }
  });

  it("passes a rubric whose numeric Check carries a finite numericTolerance and a well-formed passThreshold", async () => {
    const pack = makeValidPack({
      rubrics: {
        "tone-eval": {
          key: "tone-eval",
          description: "d",
          checks: [
            {
              name: "faithfulness",
              description: "d",
              scoringType: "numeric",
              numericTolerance: 0.1,
              passThreshold: { comparison: "gte", value: 0.8 },
            },
          ],
        },
      },
    });
    await expect(validateGraderPack(pack)).resolves.toEqual(expect.any(Array));
  });

  it("fails with malformed-rubric (one issue per missing field) when a numeric Check is missing numericTolerance and passThreshold", async () => {
    const pack = makeValidPack({
      rubrics: {
        "tone-eval": {
          key: "tone-eval",
          description: "d",
          // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the validator — slipping past the discriminated union the way an untyped/cast pack could
          checks: [{ name: "faithfulness", description: "d", scoringType: "numeric" }] as any,
        },
      },
    });
    await expectIssueCodes(pack, ["malformed-rubric", "malformed-rubric"]);
  });

  it("fails with malformed-rubric when a numeric Check's passThreshold has an invalid comparison direction", async () => {
    const pack = makeValidPack({
      rubrics: {
        "tone-eval": {
          key: "tone-eval",
          description: "d",
          checks: [
            {
              name: "faithfulness",
              description: "d",
              scoringType: "numeric",
              numericTolerance: 0.1,
              // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the validator
              passThreshold: { comparison: "greater-than", value: 0.8 } as any,
            },
          ],
        },
      },
    });
    await expectIssueCodes(pack, ["malformed-rubric"]);
  });

  it("fails with malformed-rubric when a boolean Check carries a stray numericTolerance or passThreshold", async () => {
    const pack = makeValidPack({
      rubrics: {
        "tone-eval": {
          key: "tone-eval",
          description: "d",
          checks: [
            {
              name: "on-brand-tone",
              description: "d",
              scoringType: "boolean",
              numericTolerance: 0.1,
              passThreshold: { comparison: "gte", value: 1 },
              // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the validator
            } as any,
          ],
        },
      },
    });
    await expectIssueCodes(pack, ["malformed-rubric", "malformed-rubric"]);
  });

  it("fails with malformed-rubric when a Check's scoringType is neither boolean nor numeric", async () => {
    const pack = makeValidPack({
      rubrics: {
        "tone-eval": {
          key: "tone-eval",
          description: "d",
          // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the validator
          checks: [{ name: "on-brand-tone", description: "d", scoringType: "vibes" }] as any,
        },
      },
    });
    await expectIssueCodes(pack, ["malformed-rubric"]);
  });
});
