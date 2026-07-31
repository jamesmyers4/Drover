import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraderDb, newGraderId } from "../../src/grader/db.js";
import type {
  Case,
  ConsensusRound,
  GraderPackConfigSnapshot,
  GradingRun,
  Task,
} from "../../src/grader/types.js";

const samplePackConfig: GraderPackConfigSnapshot = {
  appName: "shenny",
  rubrics: {
    "tone-eval": {
      key: "tone-eval",
      description: "Scores whether generated copy matches the target tone.",
      checks: [
        {
          name: "on-brand-tone",
          description: "Copy reads as warm and encouraging, not clinical.",
          scoringType: "boolean",
        },
        {
          name: "faithfulness",
          description: "Output doesn't state anything unsupported by input.",
          scoringType: "numeric",
          numericTolerance: 0.1,
          passThreshold: { comparison: "gte", value: 0.8 },
        },
      ],
    },
  },
  dataPolicy: "restricted",
  allowHostedEscalation: false,
};

function makeGradingRun(): GradingRun {
  return {
    id: newGraderId(),
    appName: "shenny",
    packConfig: samplePackConfig,
    status: "running",
    startedAt: Date.now(),
  };
}

function makeCase(gradingRunId: string): Case {
  return {
    id: newGraderId(),
    gradingRunId,
    input: { prompt: "Write a check-in confirmation message." },
    output: { text: "You're all checked in — thanks for volunteering today!" },
    rubric: "tone-eval",
    createdAt: Date.now(),
  };
}

describe("GraderDb", () => {
  let db: GraderDb;

  beforeEach(() => {
    db = new GraderDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("migrates cleanly on an empty database", () => {
    const fresh = new GraderDb(":memory:");
    fresh.close();
  });

  it("round-trips a grading run, including the pack config snapshot", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    expect(db.getGradingRun(run.id)).toEqual(run);
  });

  it("updateGradingRunStatus updates status and end time", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    const endedAt = run.startedAt + 5000;
    db.updateGradingRunStatus(run.id, "completed", endedAt);
    expect(db.getGradingRun(run.id)).toEqual({ ...run, status: "completed", endedAt });
  });

  it("round-trips a case, including arbitrary input/output payloads", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    const c = makeCase(run.id);
    db.insertCase(c);
    expect(db.getCase(c.id)).toEqual(c);
    expect(db.getCasesByGradingRun(run.id)).toEqual([c]);
    expect(db.getCasesByGradingRun("no-such-run")).toEqual([]);
  });

  it("round-trips a hand-built Task with a full result payload", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    const c = makeCase(run.id);
    db.insertCase(c);

    const task: Task = {
      id: newGraderId(),
      caseId: c.id,
      layerId: 3,
      status: "pass",
      modelFamily: "llama-3.1-8b",
      executionTarget: "gpu-box-1",
      rubricSnapshot: {
        key: "tone-eval",
        contentHash: "abc123",
        content: samplePackConfig.rubrics["tone-eval"] as NonNullable<
          (typeof samplePackConfig.rubrics)["tone-eval"]
        >,
      },
      checks: [
        { name: "on-brand-tone", value: true, reasoning: "Warm, encouraging phrasing throughout." },
        { name: "faithfulness", value: 0.95, reasoning: "Every claim traces back to the input." },
      ],
      startedAt: 1000,
      endedAt: 1200,
    };
    db.insertTask(task);
    expect(db.getTask(task.id)).toEqual(task);
    expect(db.getTasksByCase(c.id)).toEqual([task]);
  });

  it("round-trips a minimal pending Task with no LLM-only fields set", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    const c = makeCase(run.id);
    db.insertCase(c);

    const task: Task = {
      id: newGraderId(),
      caseId: c.id,
      layerId: 1,
      status: "pending",
      checks: [],
      startedAt: 500,
    };
    db.insertTask(task);
    const fetched = db.getTask(task.id);
    expect(fetched).toEqual(task);
    expect(fetched).not.toHaveProperty("consensusRoundId");
    expect(fetched).not.toHaveProperty("modelFamily");
    expect(fetched).not.toHaveProperty("executionTarget");
    expect(fetched).not.toHaveProperty("rubricSnapshot");
    expect(fetched).not.toHaveProperty("skippedReason");
    expect(fetched).not.toHaveProperty("endedAt");
  });

  it("round-trips a skipped Task with its justification string", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    const c = makeCase(run.id);
    db.insertCase(c);

    const task: Task = {
      id: newGraderId(),
      caseId: c.id,
      layerId: 5,
      status: "skipped",
      checks: [],
      skippedReason:
        "Structurally meaningless without Layer 3's grounded-output Check passing first.",
      startedAt: 700,
      endedAt: 700,
    };
    db.insertTask(task);
    expect(db.getTask(task.id)).toEqual(task);
  });

  it("recordTaskResult writes the final outcome onto a previously-inserted Task", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    const c = makeCase(run.id);
    db.insertCase(c);

    const task: Task = {
      id: newGraderId(),
      caseId: c.id,
      layerId: 3,
      status: "running",
      checks: [],
      startedAt: 1000,
    };
    db.insertTask(task);

    db.recordTaskResult(task.id, {
      status: "fail",
      checks: [{ name: "on-brand-tone", value: false, reasoning: "Reads as clinical, not warm." }],
      modelFamily: "mistral-7b",
      executionTarget: "gpu-box-2",
      endedAt: 1500,
    });

    const fetched = db.getTask(task.id);
    expect(fetched?.status).toBe("fail");
    expect(fetched?.checks).toEqual([
      { name: "on-brand-tone", value: false, reasoning: "Reads as clinical, not warm." },
    ]);
    expect(fetched?.modelFamily).toBe("mistral-7b");
    expect(fetched?.executionTarget).toBe("gpu-box-2");
    expect(fetched?.endedAt).toBe(1500);
  });

  it("updateTaskStatus flips status without touching the rest of the row", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    const c = makeCase(run.id);
    db.insertCase(c);

    const task: Task = {
      id: newGraderId(),
      caseId: c.id,
      layerId: 1,
      status: "pending",
      checks: [],
      startedAt: 1000,
    };
    db.insertTask(task);
    db.updateTaskStatus(task.id, "running");
    expect(db.getTask(task.id)?.status).toBe("running");
  });

  it("round-trips a hand-built ConsensusRound and resolves it per-Check", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    const c = makeCase(run.id);
    db.insertCase(c);

    const round: ConsensusRound = {
      id: newGraderId(),
      caseId: c.id,
      layerId: 3,
      checkResolutions: [],
      createdAt: 2000,
    };
    db.insertConsensusRound(round);
    expect(db.getConsensusRound(round.id)).toEqual(round);
    expect(db.getConsensusRoundsByCase(c.id)).toEqual([round]);

    db.resolveConsensusRound(
      round.id,
      [
        { name: "on-brand-tone", outcome: "agreed", finalValue: true },
        { name: "faithfulness", outcome: "escalated", finalValue: 0.8 },
      ],
      2500,
    );

    const resolved = db.getConsensusRound(round.id);
    expect(resolved?.resolvedAt).toBe(2500);
    expect(resolved?.checkResolutions).toEqual([
      { name: "on-brand-tone", outcome: "agreed", finalValue: true },
      { name: "faithfulness", outcome: "escalated", finalValue: 0.8 },
    ]);
  });

  it("links judge Tasks to their Consensus Round via consensusRoundId", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    const c = makeCase(run.id);
    db.insertCase(c);

    const round: ConsensusRound = {
      id: newGraderId(),
      caseId: c.id,
      layerId: 3,
      checkResolutions: [],
      createdAt: 2000,
    };
    db.insertConsensusRound(round);

    const judgeA: Task = {
      id: newGraderId(),
      caseId: c.id,
      layerId: 3,
      consensusRoundId: round.id,
      status: "pass",
      modelFamily: "llama-3.1-8b",
      executionTarget: "gpu-box-1",
      checks: [{ name: "on-brand-tone", value: true, reasoning: "Warm phrasing." }],
      startedAt: 2001,
      endedAt: 2100,
    };
    const judgeB: Task = {
      id: newGraderId(),
      caseId: c.id,
      layerId: 3,
      consensusRoundId: round.id,
      status: "pass",
      modelFamily: "mistral-7b",
      executionTarget: "gpu-box-2",
      checks: [{ name: "on-brand-tone", value: true, reasoning: "Encouraging tone." }],
      startedAt: 2001,
      endedAt: 2105,
    };
    db.insertTask(judgeA);
    db.insertTask(judgeB);

    const roundTasks = db.getTasksByConsensusRound(round.id);
    expect(roundTasks.map((t) => t.id).sort()).toEqual([judgeA.id, judgeB.id].sort());
    expect(roundTasks.every((t) => t.modelFamily !== undefined)).toBe(true);
    // Distinct model families across the round's judge Tasks (ADR 0003's diversity invariant) — checked by the scheduler in a later session, but the schema must be able to answer this query.
    expect(new Set(roundTasks.map((t) => t.modelFamily)).size).toBe(2);
  });

  it("enforces foreign keys and status check constraints", () => {
    expect(() => db.insertCase(makeCase("nonexistent-run"))).toThrowError(/FOREIGN KEY/);

    const run = makeGradingRun();
    db.insertGradingRun(run);
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid status
      db.insertGradingRun({ ...makeGradingRun(), status: "bogus" as any }),
    ).toThrowError(/CHECK/);
  });

  it("rejects an invalid tasks.status value", () => {
    const run = makeGradingRun();
    db.insertGradingRun(run);
    const c = makeCase(run.id);
    db.insertCase(c);

    expect(() =>
      db.insertTask({
        id: newGraderId(),
        caseId: c.id,
        layerId: 1,
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid status
        status: "bogus" as any,
        checks: [],
        startedAt: 1000,
      }),
    ).toThrowError(/CHECK/);
  });
});
