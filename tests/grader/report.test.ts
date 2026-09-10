/**
 * `buildGradingReport` (Grader Session 6). The trickiest correctness point:
 * `tasksPassed`/`tasksFailed`/`tasksSkipped` and each Case's `layers` map
 * must count only *rollup* Tasks (`consensusRoundId === undefined`) —
 * exactly the same definition `RunGradingRunResult` already uses — never a
 * Consensus Round's own judge/escalation Tasks, which also live in the
 * `tasks` table under the same `case_id` but carry a `consensusRoundId`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraderDb, newGraderId } from "../../src/grader/db.js";
import { buildGradingReport, GradingReportRunNotFoundError } from "../../src/grader/report.js";
import type { GraderPackConfigSnapshot, Rubric, Task } from "../../src/grader/types.js";

const toneRubric: Rubric = {
  key: "tone-eval",
  description: "Scores tone.",
  checks: [{ name: "on-brand-tone", description: "Warm, not clinical.", scoringType: "boolean" }],
};

const packConfig: GraderPackConfigSnapshot = {
  appName: "toy-app",
  rubrics: { "tone-eval": toneRubric },
  dataPolicy: "synthetic-only",
};

function minimalTask(overrides: Partial<Task> & Pick<Task, "caseId" | "layerId" | "status">): Task {
  return {
    id: newGraderId(),
    checks: [],
    startedAt: 0,
    endedAt: 0,
    ...overrides,
  };
}

describe("buildGradingReport", () => {
  let db: GraderDb;
  const gradingRunId = newGraderId();

  beforeEach(() => {
    db = new GraderDb(":memory:");
    db.insertGradingRun({
      id: gradingRunId,
      appName: "toy-app",
      packConfig,
      status: "completed",
      startedAt: 0,
      endedAt: 1000,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("throws GradingReportRunNotFoundError for an unknown grading run id", () => {
    expect(() => buildGradingReport(db, "nonexistent")).toThrow(GradingReportRunNotFoundError);
  });

  it("counts only rollup Tasks toward tasksPassed/tasksFailed/tasksSkipped — never a Consensus Round's own judge/escalation Tasks", () => {
    const caseId = newGraderId();
    db.insertCase({
      id: caseId,
      gradingRunId,
      input: {},
      output: {},
      rubric: "tone-eval",
      createdAt: 0,
    });

    const consensusRoundId = newGraderId();
    db.insertConsensusRound({
      id: consensusRoundId,
      caseId,
      layerId: 4,
      status: "resolved",
      checkResolutions: [{ name: "on-brand-tone", outcome: "agreed", finalValue: true }],
      createdAt: 0,
      resolvedAt: 0,
    });
    // Two judge Tasks belonging to the round — both carry consensusRoundId,
    // so neither should count toward the report's own tallies.
    db.insertTask(minimalTask({ caseId, layerId: 4, consensusRoundId, status: "pass" }));
    db.insertTask(minimalTask({ caseId, layerId: 4, consensusRoundId, status: "fail" }));
    // The layer's own rollup Task — no consensusRoundId — is what the report should count.
    db.insertTask(minimalTask({ caseId, layerId: 4, status: "pass" }));
    // An ordinary single-pass layer's rollup Task.
    db.insertTask(minimalTask({ caseId, layerId: 1, status: "skipped", skippedReason: "x" }));

    const report = buildGradingReport(db, gradingRunId);

    expect(report.tasksPassed).toBe(1);
    expect(report.tasksFailed).toBe(0);
    expect(report.tasksSkipped).toBe(1);
    expect(report.cases[0]?.layers[4]?.status).toBe("pass");
    expect(Object.keys(report.cases[0]?.layers ?? {})).toHaveLength(2);
  });

  it("computes escalationCount per Case by summing 'escalated' Check resolutions across its Consensus Rounds", () => {
    const caseId = newGraderId();
    db.insertCase({
      id: caseId,
      gradingRunId,
      input: {},
      output: {},
      rubric: "tone-eval",
      createdAt: 0,
    });
    db.insertConsensusRound({
      id: newGraderId(),
      caseId,
      layerId: 4,
      status: "resolved",
      checkResolutions: [
        { name: "check-a", outcome: "escalated", finalValue: true },
        { name: "check-b", outcome: "agreed", finalValue: true },
      ],
      createdAt: 0,
      resolvedAt: 0,
    });
    db.insertConsensusRound({
      id: newGraderId(),
      caseId,
      layerId: 5,
      status: "resolved",
      checkResolutions: [{ name: "check-c", outcome: "escalated", finalValue: false }],
      createdAt: 0,
      resolvedAt: 0,
    });

    const report = buildGradingReport(db, gradingRunId);

    expect(report.cases[0]?.escalationCount).toBe(2);
    expect(report.totalEscalations).toBe(2);
  });

  it("sorts Cases by escalation count first, skip count second, both descending", () => {
    const [caseA, caseB, caseC] = [newGraderId(), newGraderId(), newGraderId()];
    for (const id of [caseA, caseB, caseC]) {
      db.insertCase({
        id,
        gradingRunId,
        input: {},
        output: {},
        rubric: "tone-eval",
        createdAt: 0,
      });
    }
    // Case A: 1 escalation, 0 skips.
    db.insertConsensusRound({
      id: newGraderId(),
      caseId: caseA,
      layerId: 4,
      status: "resolved",
      checkResolutions: [{ name: "x", outcome: "escalated", finalValue: true }],
      createdAt: 0,
      resolvedAt: 0,
    });
    // Case B: 0 escalations, 2 skips.
    db.insertTask(
      minimalTask({ caseId: caseB, layerId: 1, status: "skipped", skippedReason: "x" }),
    );
    db.insertTask(
      minimalTask({ caseId: caseB, layerId: 2, status: "skipped", skippedReason: "x" }),
    );
    // Case C: 0 escalations, 1 skip.
    db.insertTask(
      minimalTask({ caseId: caseC, layerId: 1, status: "skipped", skippedReason: "x" }),
    );

    const report = buildGradingReport(db, gradingRunId);

    expect(report.cases.map((c) => c.caseId)).toEqual([caseA, caseB, caseC]);
  });

  it("embeds a content-hash rubric snapshot for every rubric key actually referenced by a Case", () => {
    const caseId = newGraderId();
    db.insertCase({
      id: caseId,
      gradingRunId,
      input: {},
      output: {},
      rubric: "tone-eval",
      createdAt: 0,
    });

    const report = buildGradingReport(db, gradingRunId);

    expect(report.rubricsUsed["tone-eval"]?.content).toEqual(toneRubric);
    expect(report.rubricsUsed["tone-eval"]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
