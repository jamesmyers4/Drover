/**
 * `createMultiJudgeLayer` (Grader Session 6) — the piece that ties a real
 * multi-judge Consensus Round (`consensus.ts`, Session 5) into one summary
 * `LayerCheckOutcome` the scheduler can persist and use for prerequisite
 * checks. Mirrors `judge-layer.test.ts`'s role for the single-judge layers.
 */
import { describe, expect, it } from "vitest";
import { GraderDb, newGraderId } from "../../../src/grader/db.js";
import { createMultiJudgeLayer } from "../../../src/grader/layers/consensus-layer.js";
import {
  type GraderScoreRequest,
  type GraderScoreResult,
  ScriptedGraderProvider,
} from "../../../src/grader/provider.js";
import type { Case, GraderPack, Rubric } from "../../../src/grader/types.js";

/** A ScriptedGraderProvider reporting a distinct modelFamily — the real class always reports "scripted" (same precedent `consensus.test.ts` established). */
class FamilyScriptedProvider extends ScriptedGraderProvider {
  override readonly modelFamily: string;
  constructor(
    family: string,
    script: ConstructorParameters<typeof ScriptedGraderProvider>[0],
    costPerCallUsd?: ConstructorParameters<typeof ScriptedGraderProvider>[1],
  ) {
    super(script, costPerCallUsd);
    this.modelFamily = family;
  }
}

/** A provider whose every call fails, regardless of attempt — exercises the aborted-error path without real retries taking real time (paired with a no-op sleep). */
class AlwaysFailingProvider extends FamilyScriptedProvider {
  override async score(_request: GraderScoreRequest): Promise<GraderScoreResult> {
    throw new Error("provider unreachable");
  }
}

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

function makePack(overrides?: Partial<GraderPack>): GraderPack {
  return {
    appName: "toy-app",
    rubrics: { "tone-eval": toneRubric },
    loadCases: () => [],
    dataPolicy: "synthetic-only",
    ...overrides,
  };
}

/** `runConsensusRound` writes real Task/ConsensusRound rows with an FK to `cases(id)` — seed a real grading_run + case row first (same precedent `consensus.test.ts` established). */
function seedCase(db: GraderDb, pack: GraderPack): Case {
  const gradingRunId = newGraderId();
  db.insertGradingRun({
    id: gradingRunId,
    appName: pack.appName,
    packConfig: {
      appName: pack.appName,
      rubrics: pack.rubrics,
      dataPolicy: pack.dataPolicy,
    },
    status: "running",
    startedAt: 0,
  });
  const gradingCase: Case = {
    id: newGraderId(),
    gradingRunId,
    input: { prompt: "hi" },
    output: { text: "hello!" },
    rubric: "tone-eval",
    createdAt: 0,
  };
  db.insertCase(gradingCase);
  return gradingCase;
}

const NO_SLEEP = async () => {};

describe("createMultiJudgeLayer", () => {
  it("passes when both judges agree and every Check meets its own verdict rule", async () => {
    const db = new GraderDb(":memory:");
    const pack = makePack();
    const gradingCase = seedCase(db, pack);

    const judgeVote = [
      { name: "on-brand-tone", value: true, reasoning: "Warm." },
      { name: "quality-score", value: 4, reasoning: "Solid." },
    ];
    const judges = [
      new FamilyScriptedProvider("family-a", [judgeVote]),
      new FamilyScriptedProvider("family-b", [judgeVote]),
    ];
    const escalation = new FamilyScriptedProvider("family-escalation", []);

    const layer = createMultiJudgeLayer(4, "framing", judges, escalation);
    const outcome = await layer.run({ gradingCase, pack, db, now: () => 0 });

    expect(outcome.status).toBe("pass");
    expect(outcome.checks).toHaveLength(2);
    expect(outcome.checks.every((c) => c.reasoning.includes("agreed"))).toBe(true);
    expect(outcome.rubricSnapshot?.key).toBe("tone-eval");
    db.close();
  });

  it("fails when judges agree but a numeric Check misses its passThreshold", async () => {
    const db = new GraderDb(":memory:");
    const pack = makePack();
    const gradingCase = seedCase(db, pack);

    const judgeVote = [
      { name: "on-brand-tone", value: true, reasoning: "Warm." },
      { name: "quality-score", value: 1, reasoning: "Weak." },
    ];
    const judges = [
      new FamilyScriptedProvider("family-a", [judgeVote]),
      new FamilyScriptedProvider("family-b", [judgeVote]),
    ];
    const escalation = new FamilyScriptedProvider("family-escalation", []);

    const layer = createMultiJudgeLayer(5, "framing", judges, escalation);
    const outcome = await layer.run({ gradingCase, pack, db, now: () => 0 });

    expect(outcome.status).toBe("fail");
  });

  it("escalates a disputed Check and folds the escalation's adjudicated value into the summary outcome", async () => {
    const db = new GraderDb(":memory:");
    const pack = makePack();
    const gradingCase = seedCase(db, pack);

    const judges = [
      new FamilyScriptedProvider("family-a", [
        [
          { name: "on-brand-tone", value: true, reasoning: "Warm." },
          { name: "quality-score", value: 5, reasoning: "Great." },
        ],
      ]),
      new FamilyScriptedProvider("family-b", [
        [
          { name: "on-brand-tone", value: false, reasoning: "Clinical." },
          { name: "quality-score", value: 5, reasoning: "Great." },
        ],
      ]),
    ];
    const escalation = new FamilyScriptedProvider("family-escalation", [
      [{ name: "on-brand-tone", value: true, reasoning: "Tie-break: reads warm enough." }],
    ]);

    const layer = createMultiJudgeLayer(6, "framing", judges, escalation);
    const outcome = await layer.run({ gradingCase, pack, db, now: () => 0 });

    expect(outcome.status).toBe("pass");
    const toneCheck = outcome.checks.find((c) => c.name === "on-brand-tone");
    expect(toneCheck?.value).toBe(true);
    expect(toneCheck?.reasoning).toMatch(/disagreed/);

    // The disputed Check's escalation Task and the round itself both persisted for real.
    const rounds = db.getConsensusRoundsByCase(gradingCase.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.status).toBe("resolved");
    expect(rounds[0]?.checkResolutions.filter((r) => r.outcome === "escalated")).toHaveLength(1);
    db.close();
  });

  it("reports a fail with a synthetic Check when the round aborts after exhausting retries — infrastructure noise, not a whole-run crash", async () => {
    const db = new GraderDb(":memory:");
    const pack = makePack();
    const gradingCase = seedCase(db, pack);

    const judges = [
      new AlwaysFailingProvider("family-a", []),
      new FamilyScriptedProvider("family-b", [
        [
          { name: "on-brand-tone", value: true, reasoning: "Warm." },
          { name: "quality-score", value: 4, reasoning: "Solid." },
        ],
      ]),
    ];
    const escalation = new FamilyScriptedProvider("family-escalation", []);

    const layer = createMultiJudgeLayer(7, "framing", judges, escalation, {
      maxDispatchAttempts: 1,
      sleep: NO_SLEEP,
    });
    const outcome = await layer.run({
      gradingCase,
      pack,
      db,
      now: () => 0,
    });

    expect(outcome.status).toBe("fail");
    expect(outcome.checks).toHaveLength(1);
    expect(outcome.checks[0]?.name).toBe("consensus-round-error");
    expect(outcome.checks[0]?.reasoning).toMatch(/provider unreachable/);
    db.close();
  });
});
