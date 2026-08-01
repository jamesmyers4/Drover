import { describe, expect, it } from "vitest";
import { GraderBudget, GraderBudgetExceededError } from "../../src/grader/budget.js";
import { runConsensusRound } from "../../src/grader/consensus.js";
import { GraderDb, newGraderId } from "../../src/grader/db.js";
import {
  GraderDataPolicyViolationError,
  type GraderModelProvider,
  type GraderScoreRequest,
  type GraderScoreResult,
  ScriptedGraderProvider,
} from "../../src/grader/provider.js";
import { DuplicateModelFamilyError, InsufficientJudgesError } from "../../src/grader/scheduler.js";
import type { Case, GraderPack, Rubric } from "../../src/grader/types.js";

/** No-op backoff so retry-exercising tests don't actually sleep. */
const NO_SLEEP = async () => {};

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

/** Persists a real grading_runs row and cases row — `tasks`/`consensus_rounds` both carry a real FK to `cases(id)`, so a Case used in these tests has to actually exist in the same db. */
function seedCase(db: GraderDb, rubricKey = "tone-eval"): Case {
  const gradingRunId = newGraderId();
  db.insertGradingRun({
    id: gradingRunId,
    appName: "toy-app",
    packConfig: {
      appName: "toy-app",
      rubrics: { "tone-eval": toneRubric },
      dataPolicy: "synthetic-only",
    },
    status: "running",
    startedAt: 0,
  });
  const gradingCase: Case = {
    id: newGraderId(),
    gradingRunId,
    input: { prompt: "hi" },
    output: { text: "hello!" },
    rubric: rubricKey,
    createdAt: 0,
  };
  db.insertCase(gradingCase);
  return gradingCase;
}

/** A ScriptedGraderProvider that reports a distinct modelFamily, since the real class always reports "scripted". */
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

/** Throws on every call — simulates a genuinely unreachable/broken provider surviving no retry. */
class AlwaysFailingProvider implements GraderModelProvider {
  readonly provider = "flaky";
  readonly model = "flaky";
  readonly executionTarget = "flaky";
  callCount = 0;

  constructor(
    readonly modelFamily: string,
    private readonly message: string,
  ) {}

  async score(): Promise<GraderScoreResult> {
    this.callCount++;
    throw new Error(this.message);
  }
}

/** Throws on the first `failuresBeforeSuccess` calls, then delegates to a real ScriptedGraderProvider script — simulates a transient blip that a retry recovers from. */
class FlakyThenSucceedsProvider extends ScriptedGraderProvider {
  override readonly modelFamily: string;
  private attempts = 0;

  constructor(
    family: string,
    private readonly failuresBeforeSuccess: number,
    script: ConstructorParameters<typeof ScriptedGraderProvider>[0],
  ) {
    super(script);
    this.modelFamily = family;
  }

  override async score(_request: GraderScoreRequest): Promise<GraderScoreResult> {
    this.attempts++;
    if (this.attempts <= this.failuresBeforeSuccess) {
      throw new Error(`transient failure on attempt ${this.attempts}`);
    }
    return super.score();
  }
}

describe("runConsensusRound", () => {
  it("resolves every Check as 'agreed' with no escalation Tasks when both judges agree", async () => {
    const db = new GraderDb(":memory:");
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: true, reasoning: "Warm." },
        { name: "quality-score", value: 4, reasoning: "Solid." },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: true, reasoning: "Friendly." },
        { name: "quality-score", value: 4.2, reasoning: "Good, within tolerance." },
      ],
    ]);
    const escalationProvider = new ScriptedGraderProvider([]);

    const result = await runConsensusRound({
      db,
      pack: makePack(),
      gradingCase: seedCase(db),
      layerId: 6,
      framing: "framing",
      judges: [judgeA, judgeB],
      escalationProvider,
    });

    expect(result.checkResolutions).toEqual([
      { name: "on-brand-tone", outcome: "agreed", finalValue: true },
      { name: "quality-score", outcome: "agreed", finalValue: 4.1 },
    ]);
    expect(result.escalationTasks).toHaveLength(0);
    expect(result.judgeTasks).toHaveLength(2);

    const round = db.getConsensusRound(result.consensusRoundId);
    expect(round?.resolvedAt).toBeDefined();
    expect(round?.checkResolutions).toEqual(result.checkResolutions);

    const tasks = db.getTasksByConsensusRound(result.consensusRoundId);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.consensusRoundId === result.consensusRoundId)).toBe(true);
    expect(tasks.map((t) => t.modelFamily).sort()).toEqual(["llama3.1", "qwen2.5"]);
    db.close();
  });

  it("escalates a disputed boolean Check and adopts the escalation Task's adjudicated value", async () => {
    const db = new GraderDb(":memory:");
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: true, reasoning: "Reads warm to me." },
        { name: "quality-score", value: 4, reasoning: "Solid." },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: false, reasoning: "Reads clinical to me." },
        { name: "quality-score", value: 4.1, reasoning: "Also solid." },
      ],
    ]);
    const escalationProvider = new FamilyScriptedProvider("claude-haiku-4-5", [
      [{ name: "on-brand-tone", value: false, reasoning: "Adjudicated: too clinical." }],
    ]);

    const result = await runConsensusRound({
      db,
      pack: makePack(),
      gradingCase: seedCase(db),
      layerId: 6,
      framing: "framing",
      judges: [judgeA, judgeB],
      escalationProvider,
    });

    const toneResolution = result.checkResolutions.find((r) => r.name === "on-brand-tone");
    expect(toneResolution).toEqual({
      name: "on-brand-tone",
      outcome: "escalated",
      finalValue: false,
    });
    const qualityResolution = result.checkResolutions.find((r) => r.name === "quality-score");
    expect(qualityResolution?.outcome).toBe("agreed");

    expect(result.escalationTasks).toHaveLength(1);
    expect(result.escalationTasks[0]?.checks).toEqual([
      { name: "on-brand-tone", value: false, reasoning: "Adjudicated: too clinical." },
    ]);
    expect(result.escalationTasks[0]?.consensusRoundId).toBe(result.consensusRoundId);
    expect(result.escalationTasks[0]?.modelFamily).toBe("claude-haiku-4-5");
    expect(result.escalationTasks[0]?.status).toBe("fail"); // false fails a boolean Check's own verdict rule

    const round = db.getConsensusRound(result.consensusRoundId);
    expect(round?.resolvedAt).toBeDefined();
    db.close();
  });

  it("escalates a disputed numeric Check whose spread exceeds its own numericTolerance", async () => {
    const db = new GraderDb(":memory:");
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 2, reasoning: "Weak." },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4.5, reasoning: "Strong." },
      ],
    ]);
    const escalationProvider = new FamilyScriptedProvider("claude-haiku-4-5", [
      [{ name: "quality-score", value: 4, reasoning: "Adjudicated: closer to strong." }],
    ]);

    const result = await runConsensusRound({
      db,
      pack: makePack(),
      gradingCase: seedCase(db),
      layerId: 6,
      framing: "framing",
      judges: [judgeA, judgeB],
      escalationProvider,
    });

    const qualityResolution = result.checkResolutions.find((r) => r.name === "quality-score");
    expect(qualityResolution).toEqual({
      name: "quality-score",
      outcome: "escalated",
      finalValue: 4,
    });
    expect(result.escalationTasks).toHaveLength(1);
    expect(result.escalationTasks[0]?.status).toBe("pass"); // 4 >= passThreshold 3
    db.close();
  });

  it("passes the shared Case input/output and both judges' reasoning/values into the escalation call's framing", async () => {
    const db = new GraderDb(":memory:");
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: true, reasoning: "Judge A's reasoning." },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: false, reasoning: "Judge B's reasoning." },
        { name: "quality-score", value: 4.1, reasoning: "ok" },
      ],
    ]);
    let capturedFraming = "";
    let capturedInput: unknown;
    class CapturingProvider extends ScriptedGraderProvider {
      constructor() {
        super([[{ name: "on-brand-tone", value: true, reasoning: "adjudicated" }]]);
      }
      override async score(request: GraderScoreRequest) {
        capturedFraming = request.framing;
        capturedInput = request.input;
        return super.score();
      }
    }
    const escalationProvider = new CapturingProvider();

    await runConsensusRound({
      db,
      pack: makePack(),
      gradingCase: seedCase(db),
      layerId: 6,
      framing: "framing",
      judges: [judgeA, judgeB],
      escalationProvider,
    });

    expect(capturedFraming).toContain("Judge A's reasoning");
    expect(capturedFraming).toContain("Judge B's reasoning");
    expect(capturedFraming).toContain("on-brand-tone");
    expect(capturedInput).toEqual({ prompt: "hi" });
    db.close();
  });

  it("propagates InsufficientJudgesError when fewer than 2 judges are supplied (ADR 0003)", async () => {
    const db = new GraderDb(":memory:");
    const judgeA = new FamilyScriptedProvider("qwen2.5", [[]]);
    const escalationProvider = new ScriptedGraderProvider([]);

    await expect(
      runConsensusRound({
        db,
        pack: makePack(),
        gradingCase: seedCase(db),
        layerId: 6,
        framing: "framing",
        judges: [judgeA],
        escalationProvider,
      }),
    ).rejects.toThrow(InsufficientJudgesError);
    db.close();
  });

  it("propagates DuplicateModelFamilyError when two judges share a modelFamily (ADR 0003)", async () => {
    const db = new GraderDb(":memory:");
    const judgeA = new ScriptedGraderProvider([[]]);
    const judgeB = new ScriptedGraderProvider([[]]);
    const escalationProvider = new ScriptedGraderProvider([]);

    await expect(
      runConsensusRound({
        db,
        pack: makePack(),
        gradingCase: seedCase(db),
        layerId: 6,
        framing: "framing",
        judges: [judgeA, judgeB],
        escalationProvider,
      }),
    ).rejects.toThrow(DuplicateModelFamilyError);
    db.close();
  });

  it("never dispatches an escalation call at all when nothing disagrees, even for a restricted pack with allowHostedEscalation unset — the dataPolicy gate is per-dispatch, not per-round", async () => {
    const db = new GraderDb(":memory:");
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4.1, reasoning: "ok" },
      ],
    ]);
    const escalationProvider = new ScriptedGraderProvider([]);

    const result = await runConsensusRound({
      db,
      pack: makePack({ dataPolicy: "restricted" }),
      gradingCase: seedCase(db),
      layerId: 6,
      framing: "framing",
      judges: [judgeA, judgeB],
      escalationProvider,
    });

    expect(result.escalationTasks).toHaveLength(0);
    db.close();
  });

  it("throws GraderDataPolicyViolationError before dispatching an escalation call against a restricted pack with allowHostedEscalation unset (ADR 0002 defense-in-depth)", async () => {
    const db = new GraderDb(":memory:");
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: false, reasoning: "disagree" },
        { name: "quality-score", value: 4.1, reasoning: "ok" },
      ],
    ]);
    const escalationProvider = new ScriptedGraderProvider([
      [{ name: "on-brand-tone", value: true, reasoning: "should never be reached" }],
    ]);
    const gradingCase = seedCase(db);

    await expect(
      runConsensusRound({
        db,
        pack: makePack({ dataPolicy: "restricted" }),
        gradingCase,
        layerId: 6,
        framing: "framing",
        judges: [judgeA, judgeB],
        escalationProvider,
      }),
    ).rejects.toThrow(GraderDataPolicyViolationError);

    // No escalation Task should have been persisted — the gate fired before dispatch.
    const allTasks = db.getTasksByCase(gradingCase.id);
    expect(allTasks.every((t) => t.checks[0]?.reasoning !== "should never be reached")).toBe(true);
    db.close();
  });

  it("respects an explicit allowHostedEscalation: true on a restricted pack", async () => {
    const db = new GraderDb(":memory:");
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: false, reasoning: "disagree" },
        { name: "quality-score", value: 4.1, reasoning: "ok" },
      ],
    ]);
    const escalationProvider = new FamilyScriptedProvider("claude-haiku-4-5", [
      [{ name: "on-brand-tone", value: true, reasoning: "adjudicated" }],
    ]);

    const result = await runConsensusRound({
      db,
      pack: makePack({ dataPolicy: "restricted", allowHostedEscalation: true }),
      gradingCase: seedCase(db),
      layerId: 6,
      framing: "framing",
      judges: [judgeA, judgeB],
      escalationProvider,
    });

    expect(result.escalationTasks).toHaveLength(1);
    db.close();
  });

  it("respects the budget guard: refuses a further escalation once graderCeilingUsd has already been reached", async () => {
    const db = new GraderDb(":memory:");
    // Two disputed Checks -> would need two escalation calls; budget allows only the first.
    const numericOnlyRubric: Rubric = {
      key: "two-numeric",
      description: "Two independent numeric Checks, both disputed.",
      checks: [
        {
          name: "check-a",
          description: "a",
          scoringType: "numeric",
          numericTolerance: 0.1,
          passThreshold: { comparison: "gte", value: 3 },
        },
        {
          name: "check-b",
          description: "b",
          scoringType: "numeric",
          numericTolerance: 0.1,
          passThreshold: { comparison: "gte", value: 3 },
        },
      ],
    };
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "check-a", value: 2, reasoning: "low" },
        { name: "check-b", value: 2, reasoning: "low" },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "check-a", value: 5, reasoning: "high" },
        { name: "check-b", value: 5, reasoning: "high" },
      ],
    ]);
    // Each escalation call bills exactly at the ceiling — the first is allowed (budget starts
    // at 0, below the 0.05 ceiling), but it pushes spend to the ceiling, so the second disputed
    // Check's escalation must be refused before it ever dispatches.
    const escalationProvider = new FamilyScriptedProvider(
      "claude-haiku-4-5",
      [
        [{ name: "check-a", value: 4, reasoning: "adjudicated a" }],
        [{ name: "check-b", value: 4, reasoning: "adjudicated b" }],
      ],
      0.05,
    );
    const budget = new GraderBudget(0.05);
    const gradingCase = seedCase(db, "two-numeric");

    await expect(
      runConsensusRound({
        db,
        pack: makePack({ rubrics: { "two-numeric": numericOnlyRubric } }),
        gradingCase,
        layerId: 6,
        framing: "framing",
        judges: [judgeA, judgeB],
        escalationProvider,
        budget,
      }),
    ).rejects.toThrow(GraderBudgetExceededError);

    // Only the first disputed Check's escalation actually dispatched: 2 judge Tasks (each scoring
    // both Checks in one call) + 1 scoped escalation Task for check-a — none for check-b.
    const tasks = db.getTasksByCase(gradingCase.id);
    expect(tasks).toHaveLength(3);
    const scopedEscalationTasks = tasks.filter((t) => t.checks.length === 1);
    expect(scopedEscalationTasks).toHaveLength(1);
    expect(scopedEscalationTasks[0]?.checks[0]?.name).toBe("check-a");
    expect(budget.spent).toBeCloseTo(0.05);
    db.close();
  });

  it("retries a judge dispatch that fails once, then succeeds and resolves the round normally", async () => {
    const db = new GraderDb(":memory:");
    const gradingCase = seedCase(db);
    const flakyJudge = new FlakyThenSucceedsProvider("qwen2.5", 1, [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4.1, reasoning: "ok" },
      ],
    ]);
    const escalationProvider = new ScriptedGraderProvider([]);

    const result = await runConsensusRound({
      db,
      pack: makePack(),
      gradingCase,
      layerId: 6,
      framing: "framing",
      judges: [flakyJudge, judgeB],
      escalationProvider,
      sleep: NO_SLEEP,
    });

    expect(result.status).toBe("resolved");
    expect(result.judgeTasks).toHaveLength(2);
    expect(db.getConsensusRound(result.consensusRoundId)?.status).toBe("resolved");
    db.close();
  });

  it("aborts the round without throwing once a judge dispatch exhausts every retry attempt, preserving the other judge's already-persisted Task", async () => {
    const db = new GraderDb(":memory:");
    const gradingCase = seedCase(db);
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const alwaysFailingJudge = new AlwaysFailingProvider("llama3.1", "judge unreachable");

    const result = await runConsensusRound({
      db,
      pack: makePack(),
      gradingCase,
      layerId: 6,
      framing: "framing",
      judges: [judgeA, alwaysFailingJudge],
      escalationProvider: new ScriptedGraderProvider([]),
      maxDispatchAttempts: 2,
      sleep: NO_SLEEP,
    });

    expect(result.status).toBe("aborted-error");
    expect(result.abortedReason).toBe("judge unreachable");
    expect(alwaysFailingJudge.callCount).toBe(2); // exactly maxDispatchAttempts, no more, no fewer
    expect(result.judgeTasks).toHaveLength(1); // judgeA's Task survives the round's overall failure
    expect(result.judgeTasks[0]?.modelFamily).toBe("qwen2.5");
    expect(result.escalationTasks).toHaveLength(0);
    expect(result.checkResolutions).toEqual([]);

    const round = db.getConsensusRound(result.consensusRoundId);
    expect(round?.status).toBe("aborted-error");
    expect(round?.abortedReason).toBe("judge unreachable");
    expect(round?.abortedAt).toBeDefined();
    expect(round?.resolvedAt).toBeUndefined();

    // The real judge Task row is durably persisted regardless of the round's own outcome.
    const tasks = db.getTasksByConsensusRound(result.consensusRoundId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.modelFamily).toBe("qwen2.5");
    db.close();
  });

  it("retries an escalation dispatch that fails once, then succeeds and resolves the round normally", async () => {
    const db = new GraderDb(":memory:");
    const gradingCase = seedCase(db);
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: false, reasoning: "disagree" },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: true, reasoning: "disagree" },
        { name: "quality-score", value: 4.1, reasoning: "ok" },
      ],
    ]);
    const flakyEscalation = new (class extends FlakyThenSucceedsProvider {
      constructor() {
        super("claude-haiku-4-5", 1, [
          [{ name: "on-brand-tone", value: true, reasoning: "adjudicated" }],
        ]);
      }
    })();

    const result = await runConsensusRound({
      db,
      pack: makePack(),
      gradingCase,
      layerId: 6,
      framing: "framing",
      judges: [judgeA, judgeB],
      escalationProvider: flakyEscalation,
      sleep: NO_SLEEP,
    });

    expect(result.status).toBe("resolved");
    expect(result.escalationTasks).toHaveLength(1);
    expect(result.escalationTasks[0]?.checks[0]?.value).toBe(true);
    db.close();
  });

  it("aborts the round once an escalation dispatch exhausts every retry attempt, preserving Checks already resolved as 'agreed' before the failure", async () => {
    const db = new GraderDb(":memory:");
    const gradingCase = seedCase(db);
    // "on-brand-tone" is checked first (rubric order) and both judges agree on it; "quality-score"
    // disagrees and needs escalation, which is where the always-failing provider comes in.
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 2, reasoning: "low" },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4.5, reasoning: "high" },
      ],
    ]);
    const alwaysFailingEscalation = new AlwaysFailingProvider(
      "claude-haiku-4-5",
      "escalation provider unreachable",
    );

    const result = await runConsensusRound({
      db,
      pack: makePack(),
      gradingCase,
      layerId: 6,
      framing: "framing",
      judges: [judgeA, judgeB],
      escalationProvider: alwaysFailingEscalation,
      maxDispatchAttempts: 2,
      sleep: NO_SLEEP,
    });

    expect(result.status).toBe("aborted-error");
    expect(result.abortedReason).toBe("escalation provider unreachable");
    expect(result.checkResolutions).toEqual([
      { name: "on-brand-tone", outcome: "agreed", finalValue: true },
    ]);
    expect(result.judgeTasks).toHaveLength(2);
    expect(result.escalationTasks).toHaveLength(0);

    const round = db.getConsensusRound(result.consensusRoundId);
    expect(round?.status).toBe("aborted-error");
    expect(round?.checkResolutions).toEqual([
      { name: "on-brand-tone", outcome: "agreed", finalValue: true },
    ]);
    db.close();
  });

  it("still throws (never softened into aborted-error) when a guard rejects the round, distinguishing a deliberate stop from provider infrastructure noise", async () => {
    const db = new GraderDb(":memory:");
    const gradingCase = seedCase(db);
    const judgeA = new FamilyScriptedProvider("qwen2.5", [
      [
        { name: "on-brand-tone", value: true, reasoning: "ok" },
        { name: "quality-score", value: 4, reasoning: "ok" },
      ],
    ]);
    const judgeB = new FamilyScriptedProvider("llama3.1", [
      [
        { name: "on-brand-tone", value: false, reasoning: "disagree" },
        { name: "quality-score", value: 4.1, reasoning: "ok" },
      ],
    ]);
    const escalationProvider = new ScriptedGraderProvider([
      [{ name: "on-brand-tone", value: true, reasoning: "should never be reached" }],
    ]);

    // A restricted pack with allowHostedEscalation unset is a policy violation, not a transient
    // fault — it must still reject the promise outright rather than resolve with aborted-error.
    await expect(
      runConsensusRound({
        db,
        pack: makePack({ dataPolicy: "restricted" }),
        gradingCase,
        layerId: 6,
        framing: "framing",
        judges: [judgeA, judgeB],
        escalationProvider,
        sleep: NO_SLEEP,
      }),
    ).rejects.toThrow(GraderDataPolicyViolationError);
    db.close();
  });
});
