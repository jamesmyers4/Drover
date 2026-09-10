/**
 * Grading report data assembly (FUTUREPLAN.md Grader Session 6) — Grader's
 * own analogue of `src/report/report.ts`'s `buildRunReport` for the
 * simulation stack. Reads only `grader.sqlite`, same "no re-grading, no
 * live pack needed" separation `buildRunReport` already established for
 * `drover report`.
 *
 * Per-Case detail comes only from each layer's *rollup* Task — the one
 * `dispatchCaseTasks` persists from a `LayerImplementation.run()` return
 * value, identifiable by `consensusRoundId === undefined` (a Consensus
 * Round's own judge/escalation Tasks always carry a `consensusRoundId`;
 * `consensus-layer.ts`'s rollup Task never does — see that module's header
 * comment). This is deliberately the same definition of "a Task" that
 * `RunGradingRunResult.tasksPassed/tasksFailed/tasksSkipped` already use
 * (`dispatchCaseTasks` only ever tallies the rollup outcome, since judge/
 * escalation Tasks are opaque to it, persisted directly by
 * `runConsensusRound` instead) — this report's own tallies stay consistent
 * with those rather than double-counting a Consensus Round's internal
 * judge/escalation Tasks as if they were separate layer results.
 */

import type { GraderDb } from "./db.js";
import { snapshotRubric } from "./rubric.js";
import type {
  CheckResult,
  GraderPackConfigSnapshot,
  GradingRunStatus,
  LayerId,
  RubricSnapshot,
  TaskStatus,
} from "./types.js";

export class GradingReportRunNotFoundError extends Error {
  constructor(gradingRunId: string) {
    super(`No grading run found with id "${gradingRunId}".`);
    this.name = "GradingReportRunNotFoundError";
  }
}

export interface GradingReportLayerCell {
  status: TaskStatus;
  checks: CheckResult[];
  skippedReason?: string;
}

export interface GradingReportCaseRow {
  caseId: string;
  rubricKey: string;
  input: unknown;
  output: unknown;
  /** Sparse — only layer ids whose rollup Task actually dispatched for this Case. */
  layers: Partial<Record<LayerId, GradingReportLayerCell>>;
  /** Sum, across this Case's Consensus Rounds, of Checks resolved via escalation (Q10's per-Case escalation signal). */
  escalationCount: number;
  /** Count of this Case's rollup Tasks with status "skipped". */
  skipCount: number;
}

export interface GradingReport {
  gradingRunId: string;
  appName: string;
  status: GradingRunStatus;
  startedAt: number;
  endedAt?: number;
  packConfig: GraderPackConfigSnapshot;
  casesProcessed: number;
  tasksPassed: number;
  tasksFailed: number;
  tasksSkipped: number;
  totalEscalations: number;
  /** Triage-sorted: escalation count desc, then skip count desc (Q14) — Cases needing the most attention first. */
  cases: GradingReportCaseRow[];
  /** Every rubric key actually referenced by a Case in this run, content-hash + full criteria embedded (Q14: "stays self-contained months later"). */
  rubricsUsed: Record<string, RubricSnapshot>;
}

export function buildGradingReport(db: GraderDb, gradingRunId: string): GradingReport {
  const run = db.getGradingRun(gradingRunId);
  if (!run) throw new GradingReportRunNotFoundError(gradingRunId);

  const cases = db.getCasesByGradingRun(gradingRunId);

  let tasksPassed = 0;
  let tasksFailed = 0;
  let tasksSkipped = 0;
  let totalEscalations = 0;
  const rubricsUsed: Record<string, RubricSnapshot> = {};

  const caseRows: GradingReportCaseRow[] = cases.map((c) => {
    const rollupTasks = db.getTasksByCase(c.id).filter((t) => t.consensusRoundId === undefined);

    const layers: Partial<Record<LayerId, GradingReportLayerCell>> = {};
    let skipCount = 0;
    for (const task of rollupTasks) {
      layers[task.layerId] = {
        status: task.status,
        checks: task.checks,
        ...(task.skippedReason !== undefined && { skippedReason: task.skippedReason }),
      };
      if (task.status === "pass") tasksPassed++;
      else if (task.status === "fail") tasksFailed++;
      else if (task.status === "skipped") {
        tasksSkipped++;
        skipCount++;
      }
    }

    const escalationCount = db
      .getConsensusRoundsByCase(c.id)
      .reduce(
        (sum, round) =>
          sum + round.checkResolutions.filter((cr) => cr.outcome === "escalated").length,
        0,
      );
    totalEscalations += escalationCount;

    if (rubricsUsed[c.rubric] === undefined) {
      const rubric = run.packConfig.rubrics[c.rubric];
      if (rubric) rubricsUsed[c.rubric] = snapshotRubric(rubric);
    }

    return {
      caseId: c.id,
      rubricKey: c.rubric,
      input: c.input,
      output: c.output,
      layers,
      escalationCount,
      skipCount,
    };
  });

  caseRows.sort(
    (a, b) =>
      b.escalationCount - a.escalationCount ||
      b.skipCount - a.skipCount ||
      a.caseId.localeCompare(b.caseId),
  );

  return {
    gradingRunId: run.id,
    appName: run.appName,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    packConfig: run.packConfig,
    casesProcessed: cases.length,
    tasksPassed,
    tasksFailed,
    tasksSkipped,
    totalEscalations,
    cases: caseRows,
    rubricsUsed,
  };
}
