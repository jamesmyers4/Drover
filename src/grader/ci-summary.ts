/**
 * The CI-facing JSON summary (FUTUREPLAN.md Grader Session 7; ADR 0005) —
 * a durable, versioned machine contract, deliberately distinct from the
 * human-facing Grading report (`report-markdown.ts`, Q14/CONTEXT.md's
 * Grading report glossary entry): different audiences with different
 * stability needs, so improving the markdown report's detail/framing over
 * time is never a breaking change to a consuming repo's CI parser.
 *
 * Derived from an already-built `GradingReport` (`report.ts`) rather than
 * re-querying `GraderDb` a second time — `buildGradingReport` is the single
 * source of truth for the case/layer/escalation/skip computation; this
 * module only reshapes and subsets that into the versioned contract. Two
 * deliberate omissions relative to the markdown report, both because this
 * artifact is meant for programmatic gating/rendering, not content review:
 * `Case.input`/`Case.output` aren't included (a human reviewing content
 * opens the markdown report or the database directly), and each rubric's
 * full criteria text isn't repeated per Case — a `rubricKeysUsed`/
 * `rubricsUsed` map at the top level (content hash + full definition, same
 * self-containment Q14 wanted for the markdown report) covers that once.
 *
 * `schemaVersion` starts at 1 per ADR 0005's explicit intent ("the schema
 * should be versioned... so a future format change is an explicit,
 * plannable migration for consuming CI, not an unplanned breakage") — the
 * exact bump/deprecation scheme beyond "increment on any breaking shape
 * change" is still open (FUTUREPLAN.md's own "explicitly still open" list),
 * not decided here.
 */

import type { GradingReport } from "./report.js";
import type {
  CheckResult,
  GradingRunStatus,
  LayerId,
  RubricSnapshot,
  TaskStatus,
} from "./types.js";

export const CI_SUMMARY_SCHEMA_VERSION = 1;

export interface CiLayerResult {
  status: TaskStatus;
  /** Never collapsed to bare pass/fail (ADR 0005) — every Check's own name/value/reasoning survives. */
  checks: CheckResult[];
  skippedReason?: string;
}

export interface CiCaseResult {
  caseId: string;
  rubricKey: string;
  /** Sparse — only layer ids that actually dispatched a Task for this Case. */
  layers: Partial<Record<LayerId, CiLayerResult>>;
  escalationCount: number;
  skipCount: number;
}

export interface GraderCiSummary {
  schemaVersion: number;
  gradingRunId: string;
  appName: string;
  status: GradingRunStatus;
  startedAt: number;
  endedAt?: number;
  casesProcessed: number;
  tasksPassed: number;
  tasksFailed: number;
  tasksSkipped: number;
  totalEscalations: number;
  /** Same triage ordering as the markdown report (escalation count desc, then skip count desc) — a consuming workflow gets the same "most likely to need attention first" ordering for free. */
  cases: CiCaseResult[];
  /** Every rubric key actually referenced by a Case this run, content-hash + full definition — self-contained the same way the markdown report is (Q14), so a consumer never needs a live GraderPack to interpret this file. */
  rubricsUsed: Record<string, RubricSnapshot>;
}

export function buildGraderCiSummary(report: GradingReport): GraderCiSummary {
  return {
    schemaVersion: CI_SUMMARY_SCHEMA_VERSION,
    gradingRunId: report.gradingRunId,
    appName: report.appName,
    status: report.status,
    startedAt: report.startedAt,
    ...(report.endedAt !== undefined && { endedAt: report.endedAt }),
    casesProcessed: report.casesProcessed,
    tasksPassed: report.tasksPassed,
    tasksFailed: report.tasksFailed,
    tasksSkipped: report.tasksSkipped,
    totalEscalations: report.totalEscalations,
    cases: report.cases.map((c) => ({
      caseId: c.caseId,
      rubricKey: c.rubricKey,
      layers: c.layers,
      escalationCount: c.escalationCount,
      skipCount: c.skipCount,
    })),
    rubricsUsed: report.rubricsUsed,
  };
}
