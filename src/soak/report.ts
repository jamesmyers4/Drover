/**
 * `drover soak report`'s entry point (CTS.md Soak Session 7) — reads only
 * already-persisted data, same "no re-simulation, no re-analysis" rule
 * `buildRunReport` already follows for the simulation stack. Reads
 * `soak.sqlite` always; optionally opens `grader.sqlite` too (when supplied
 * and this run has a linked `gradingRunId`) to embed the Grader pass's own
 * report — still just reading already-computed data, not re-grading
 * anything.
 */

import type { GraderDb } from "../grader/db.js";
import { buildGradingReport, GradingReportRunNotFoundError } from "../grader/report.js";
import { renderGradingReportMarkdown } from "../grader/report-markdown.js";
import type { SoakDb } from "./db.js";
import type { CrossTurnFindingRecord, SoakRunStatus, TurnRecord } from "./types.js";

export class SoakReportRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`No soak run found with id "${runId}".`);
    this.name = "SoakReportRunNotFoundError";
  }
}

export interface TurnVolumeByLane {
  lane: string;
  count: number;
  explicitErrorCount: number;
  gatedCount: number;
}

/** Turns grouped by their literal `errorDetail` string — a plain volume/grouping view, distinct from the cross-turn pass's own semantically-grouped `recurring-error-cluster` findings. */
export interface ExplicitErrorCluster {
  errorDetail: string;
  count: number;
  turnIds: string[];
}

export interface SoakReport {
  runId: string;
  appName: string;
  status: SoakRunStatus;
  startedAt: number;
  endedAt?: number;
  budgetCeilingUsd: number;
  spentUsd: number;
  crossTurnCostUsd?: number;
  turnsByLane: TurnVolumeByLane[];
  explicitErrorClusters: ExplicitErrorCluster[];
  crossTurnFindings: CrossTurnFindingRecord[];
  /** Present only when a linked Grader pass was found and successfully read from `graderDb`. */
  graderReportMarkdown?: string;
  /** Present only when a `gradingRunId` is linked but couldn't be read (e.g. `graderDb` omitted, or pointed at the wrong file). */
  graderUnavailableReason?: string;
}

const GATING_HTTP_STATUSES: ReadonlySet<number> = new Set([402, 429]);

function buildTurnsByLane(turns: TurnRecord[]): TurnVolumeByLane[] {
  const byLane = new Map<string, TurnVolumeByLane>();
  for (const turn of turns) {
    let entry = byLane.get(turn.lane);
    if (!entry) {
      entry = { lane: turn.lane, count: 0, explicitErrorCount: 0, gatedCount: 0 };
      byLane.set(turn.lane, entry);
    }
    entry.count++;
    if (turn.explicitError) entry.explicitErrorCount++;
    else if (turn.httpStatus !== undefined && GATING_HTTP_STATUSES.has(turn.httpStatus)) {
      entry.gatedCount++;
    }
  }
  return [...byLane.values()].sort((a, b) => a.lane.localeCompare(b.lane));
}

function buildExplicitErrorClusters(turns: TurnRecord[]): ExplicitErrorCluster[] {
  const byDetail = new Map<string, ExplicitErrorCluster>();
  for (const turn of turns) {
    if (!turn.explicitError) continue;
    const errorDetail = turn.errorDetail ?? "(no error detail recorded)";
    let entry = byDetail.get(errorDetail);
    if (!entry) {
      entry = { errorDetail, count: 0, turnIds: [] };
      byDetail.set(errorDetail, entry);
    }
    entry.count++;
    entry.turnIds.push(turn.id);
  }
  return [...byDetail.values()].sort((a, b) => b.count - a.count);
}

export function buildSoakReport(db: SoakDb, runId: string, graderDb?: GraderDb): SoakReport {
  const run = db.getSoakRun(runId);
  if (!run) throw new SoakReportRunNotFoundError(runId);

  const turns = db.getTurnsByRun(runId);
  const crossTurnFindings = db.getCrossTurnFindingsByRun(runId);

  let graderReportMarkdown: string | undefined;
  let graderUnavailableReason: string | undefined;
  if (run.gradingRunId !== undefined) {
    if (!graderDb) {
      graderUnavailableReason = `run has a linked Grader pass (gradingRunId "${run.gradingRunId}") but no graderDb was supplied to read it from`;
    } else {
      try {
        graderReportMarkdown = renderGradingReportMarkdown(
          buildGradingReport(graderDb, run.gradingRunId),
        );
      } catch (err) {
        graderUnavailableReason =
          err instanceof GradingReportRunNotFoundError
            ? `linked GradingRun "${run.gradingRunId}" was not found in the supplied graderDb`
            : `failed to read the linked Grader pass: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  return {
    runId: run.id,
    appName: run.appName,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    budgetCeilingUsd: run.budgetCeilingUsd,
    spentUsd: run.spentUsd,
    ...(run.crossTurnCostUsd !== undefined && { crossTurnCostUsd: run.crossTurnCostUsd }),
    turnsByLane: buildTurnsByLane(turns),
    explicitErrorClusters: buildExplicitErrorClusters(turns),
    crossTurnFindings,
    ...(graderReportMarkdown !== undefined && { graderReportMarkdown }),
    ...(graderUnavailableReason !== undefined && { graderUnavailableReason }),
  };
}
