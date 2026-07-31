import { describe, expect, it } from "vitest";
import { createSingleJudgeLayer } from "../../../src/grader/layers/judge-layer.js";
import { createLayer2 } from "../../../src/grader/layers/layer2.js";
import { createLayer3 } from "../../../src/grader/layers/layer3.js";
import { GOLDEN_REGRESSION_FRAMING, LLM_JUDGE_FRAMING } from "../../../src/grader/prompt.js";
import { ScriptedGraderProvider } from "../../../src/grader/provider.js";
import type { Case, GraderPack, Rubric } from "../../../src/grader/types.js";

const toneRubric: Rubric = {
  key: "tone-eval",
  description: "Scores tone and overall quality.",
  checks: [
    { name: "on-brand-tone", description: "Reads as warm, not clinical.", scoringType: "boolean" },
    {
      name: "quality-score",
      description: "1-5 overall quality.",
      scoringType: "numeric",
      numericTolerance: 0.5,
      passThreshold: { comparison: "gte", value: 3 },
    },
  ],
};

const numericOnlyRubric: Rubric = {
  key: "numeric-only",
  description: "Only scored Checks, no boolean gate.",
  checks: [
    {
      name: "quality-score",
      description: "1-5 overall quality.",
      scoringType: "numeric",
      numericTolerance: 0.5,
      passThreshold: { comparison: "gte", value: 3 },
    },
  ],
};

const hallucinationRateRubric: Rubric = {
  key: "hallucination-rate",
  description: "Lower-is-better numeric Check, exercising the 'lte' comparison direction.",
  checks: [
    {
      name: "hallucination-rate",
      description: "Fraction of unsupported claims (0-1).",
      scoringType: "numeric",
      numericTolerance: 0.05,
      passThreshold: { comparison: "lte", value: 0.1 },
    },
  ],
};

function makePack(rubrics: Record<string, Rubric>): GraderPack {
  return {
    appName: "toy-app",
    rubrics,
    loadCases: () => [],
    dataPolicy: "synthetic-only",
  };
}

function makeCase(rubricKey: string): Case {
  return {
    id: "case-1",
    gradingRunId: "run-1",
    input: { prompt: "hi" },
    output: { text: "hello!" },
    rubric: rubricKey,
    createdAt: 0,
  };
}

describe("createSingleJudgeLayer", () => {
  it("passes when every Check passes its own verdict rule (boolean true, numeric meets its passThreshold)", async () => {
    const provider = new ScriptedGraderProvider([
      [
        { name: "on-brand-tone", value: true, reasoning: "Warm greeting." },
        { name: "quality-score", value: 4, reasoning: "Solid overall." },
      ],
    ]);
    const layer = createSingleJudgeLayer(3, "framing", provider);
    const pack = makePack({ "tone-eval": toneRubric });

    const outcome = await layer.run({ gradingCase: makeCase("tone-eval"), pack });

    expect(outcome.status).toBe("pass");
    expect(outcome.checks).toHaveLength(2);
  });

  it("fails when a boolean Check is false", async () => {
    const provider = new ScriptedGraderProvider([
      [
        { name: "on-brand-tone", value: false, reasoning: "Too clinical." },
        { name: "quality-score", value: 5, reasoning: "Otherwise strong." },
      ],
    ]);
    const layer = createSingleJudgeLayer(3, "framing", provider);
    const pack = makePack({ "tone-eval": toneRubric });

    const outcome = await layer.run({ gradingCase: makeCase("tone-eval"), pack });

    expect(outcome.status).toBe("fail");
  });

  it("fails when a numeric Check misses its passThreshold, even though the boolean Check passes", async () => {
    const provider = new ScriptedGraderProvider([
      [
        { name: "on-brand-tone", value: true, reasoning: "Warm greeting." },
        { name: "quality-score", value: 1, reasoning: "Weak." },
      ],
    ]);
    const layer = createSingleJudgeLayer(3, "framing", provider);
    const pack = makePack({ "tone-eval": toneRubric });

    const outcome = await layer.run({ gradingCase: makeCase("tone-eval"), pack });

    expect(outcome.status).toBe("fail");
  });

  it("passes a rubric made entirely of numeric Checks when the score meets its passThreshold", async () => {
    const provider = new ScriptedGraderProvider([
      [{ name: "quality-score", value: 4, reasoning: "Strong." }],
    ]);
    const layer = createSingleJudgeLayer(3, "framing", provider);
    const pack = makePack({ "numeric-only": numericOnlyRubric });

    const outcome = await layer.run({ gradingCase: makeCase("numeric-only"), pack });

    expect(outcome.status).toBe("pass");
  });

  it("fails a rubric made entirely of numeric Checks when the score misses its passThreshold — the exact scenario the schema used to leave undefined", async () => {
    const provider = new ScriptedGraderProvider([
      [{ name: "quality-score", value: 1, reasoning: "Very weak." }],
    ]);
    const layer = createSingleJudgeLayer(3, "framing", provider);
    const pack = makePack({ "numeric-only": numericOnlyRubric });

    const outcome = await layer.run({ gradingCase: makeCase("numeric-only"), pack });

    expect(outcome.status).toBe("fail");
  });

  it("respects a 'lte' comparison direction (lower-is-better metric)", async () => {
    const passingProvider = new ScriptedGraderProvider([
      [{ name: "hallucination-rate", value: 0.05, reasoning: "Well under the ceiling." }],
    ]);
    const failingProvider = new ScriptedGraderProvider([
      [{ name: "hallucination-rate", value: 0.4, reasoning: "Too many unsupported claims." }],
    ]);
    const pack = makePack({ "hallucination-rate": hallucinationRateRubric });

    const passingOutcome = await createSingleJudgeLayer(3, "framing", passingProvider).run({
      gradingCase: makeCase("hallucination-rate"),
      pack,
    });
    const failingOutcome = await createSingleJudgeLayer(3, "framing", failingProvider).run({
      gradingCase: makeCase("hallucination-rate"),
      pack,
    });

    expect(passingOutcome.status).toBe("pass");
    expect(failingOutcome.status).toBe("fail");
  });

  it("attaches modelFamily/executionTarget from the provider and a rubric snapshot", async () => {
    const provider = new ScriptedGraderProvider([
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const layer = createSingleJudgeLayer(3, "framing", provider);
    const pack = makePack({ "tone-eval": toneRubric });

    const outcome = await layer.run({ gradingCase: makeCase("tone-eval"), pack });

    expect(outcome.modelFamily).toBe("scripted");
    expect(outcome.executionTarget).toBe("scripted");
    expect(outcome.rubricSnapshot?.key).toBe("tone-eval");
    expect(outcome.rubricSnapshot?.content).toEqual(toneRubric);
  });

  it("propagates UnknownRubricError when the Case's rubric key isn't declared on the pack", async () => {
    const provider = new ScriptedGraderProvider([[{ name: "x", value: true, reasoning: "a" }]]);
    const layer = createSingleJudgeLayer(3, "framing", provider);
    const pack = makePack({ "tone-eval": toneRubric });

    await expect(layer.run({ gradingCase: makeCase("typo-eval"), pack })).rejects.toThrow(
      /isn't declared in GraderPack.rubrics/,
    );
  });
});

describe("createLayer2 (golden dataset regression)", () => {
  it("is registered as layer id 2 and uses the golden-regression framing", async () => {
    const provider = new ScriptedGraderProvider([
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const layer = createLayer2(provider);
    expect(layer.layerId).toBe(2);

    const pack = makePack({ "tone-eval": toneRubric });
    const outcome = await layer.run({ gradingCase: makeCase("tone-eval"), pack });
    expect(outcome.status).toBe("pass");
  });

  it("golden-regression framing differs from the LLM-judge framing", () => {
    expect(GOLDEN_REGRESSION_FRAMING).not.toBe(LLM_JUDGE_FRAMING);
  });
});

describe("createLayer3 (single LLM-judge)", () => {
  it("is registered as layer id 3", async () => {
    const provider = new ScriptedGraderProvider([
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const layer = createLayer3(provider);
    expect(layer.layerId).toBe(3);

    const pack = makePack({ "tone-eval": toneRubric });
    const outcome = await layer.run({ gradingCase: makeCase("tone-eval"), pack });
    expect(outcome.status).toBe("pass");
  });
});
