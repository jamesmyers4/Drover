/**
 * Report data assembly from a completed run's SQLite data (CONTEXT.md
 * "Reporting"; CLAUDE.md Session 6). Reads only what's on disk — `drover
 * report` can run against a run's `.sqlite` file independently of `run`/
 * `analyze`, same separation `analyze` already established.
 *
 * Findings from both tables (in-session, cross-session) are merged by
 * match_key into one row per unique finding — the two type enums never
 * overlap (src/matching/match-key.ts embeds the type in the key), so an
 * in-session and a cross-session finding can never collide on match_key. A
 * row's `status` comes from *this run's own* finding_status_history record
 * for its match_key (written by reconcileRunFindings). A match_key can also
 * have a "resolved" status record for this run without ever appearing in the
 * findings list — reconciliation writes that when a match_key was open going
 * into the run and simply wasn't seen this time, so there's no current-run
 * finding row to attach the tag to. Those still count toward
 * `reconciliation.resolved`, just not toward any row in `findings`.
 */

import type { DroverDb } from "../db/database.js";
import type {
  BudgetConfig,
  FindingSeverity,
  FindingStatus,
  RunDimensions,
  RunStatus,
} from "../types/index.js";

/** Named distinctly from the analyst tier's own RunNotFoundError so both can be re-exported from the top-level barrel without colliding. */
export class ReportRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`No run found with id "${runId}".`);
    this.name = "RunNotFoundError";
  }
}

export interface EvidenceRef {
  screenshotPath?: string;
  /** Empty for a finding with no in-session occurrence in this run (a purely cross-session pattern anchors to a set of sessions, not a single event). */
  eventIds: string[];
}

export interface FindingReportRow {
  matchKey: string;
  type: string;
  severity: FindingSeverity;
  description: string;
  sessionIds: string[];
  goalIds: string[];
  /** "unknown" only if this row's match_key has no status record for this run (e.g. reconciliation hasn't run — shouldn't happen in practice post-`drover run`). */
  status: FindingStatus | "unknown";
  evidence: EvidenceRef;
}

export interface RunReport {
  runId: string;
  appName: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  runDimensions: RunDimensions;
  budget: BudgetConfig;
  actorCostUsd?: number;
  analystCostUsd?: number;
  /** False when `drover analyze` hasn't run for this run yet — cross-session findings/status may be incomplete (GAPS.md). */
  hasAnalystPass: boolean;
  reconciliation: { new: number; stillOpen: number; resolved: number };
  /** One row per unique match_key, severity-then-type-then-key sorted. */
  findings: FindingReportRow[];
  /** The same rows, grouped by every Goal.id any contributing session belongs to (a row can appear under more than one goal). */
  findingsByFlow: Record<string, FindingReportRow[]>;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function buildRunReport(db: DroverDb, runId: string): RunReport {
  const run = db.getRun(runId);
  if (!run) throw new ReportRunNotFoundError(runId);

  const sessions = db.getSessionsByRun(runId);
  const goalIdBySession = new Map(sessions.map((s) => [s.id, s.goalId]));
  const statusByMatchKey = new Map(
    db.getStatusHistoryForRun(runId).map((r) => [r.matchKey, r.status]),
  );

  const rows = new Map<string, FindingReportRow>();

  function rowFor(
    matchKey: string,
    type: string,
    severity: FindingSeverity,
    description: string,
  ): FindingReportRow {
    const existing = rows.get(matchKey);
    if (existing) return existing;
    const created: FindingReportRow = {
      matchKey,
      type,
      severity,
      description,
      sessionIds: [],
      goalIds: [],
      status: statusByMatchKey.get(matchKey) ?? "unknown",
      evidence: { eventIds: [] },
    };
    rows.set(matchKey, created);
    return created;
  }

  function touchSession(row: FindingReportRow, sessionId: string): void {
    if (!row.sessionIds.includes(sessionId)) row.sessionIds.push(sessionId);
    const goalId = goalIdBySession.get(sessionId);
    if (goalId !== undefined && !row.goalIds.includes(goalId)) row.goalIds.push(goalId);
  }

  for (const session of sessions) {
    for (const finding of db.getInSessionFindingsBySession(session.id)) {
      const row = rowFor(finding.matchKey, finding.type, finding.severity, finding.description);
      touchSession(row, session.id);
      row.evidence.eventIds.push(finding.eventId);
      if (row.evidence.screenshotPath === undefined && finding.screenshotPath !== undefined) {
        row.evidence.screenshotPath = finding.screenshotPath;
      }
    }
  }

  for (const finding of db.getCrossSessionFindingsByRun(runId)) {
    const row = rowFor(finding.matchKey, finding.type, finding.severity, finding.description);
    for (const sessionId of finding.sessionIds) touchSession(row, sessionId);
    if (row.evidence.screenshotPath === undefined && finding.screenshotPath !== undefined) {
      row.evidence.screenshotPath = finding.screenshotPath;
    }
  }

  const findings = Array.from(rows.values()).sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.type.localeCompare(b.type) ||
      a.matchKey.localeCompare(b.matchKey),
  );

  const findingsByFlow: Record<string, FindingReportRow[]> = {};
  for (const row of findings) {
    for (const goalId of row.goalIds) {
      if (!findingsByFlow[goalId]) findingsByFlow[goalId] = [];
      findingsByFlow[goalId].push(row);
    }
  }

  const reconciliation = { new: 0, stillOpen: 0, resolved: 0 };
  for (const status of statusByMatchKey.values()) {
    if (status === "new") reconciliation.new++;
    else if (status === "still-open") reconciliation.stillOpen++;
    else if (status === "resolved") reconciliation.resolved++;
  }

  return {
    runId: run.id,
    appName: run.appName,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    runDimensions: run.config.runDimensions,
    budget: run.config.budget,
    ...(run.actorCostUsd !== undefined && { actorCostUsd: run.actorCostUsd }),
    ...(run.analystCostUsd !== undefined && { analystCostUsd: run.analystCostUsd }),
    hasAnalystPass: run.analystCostUsd !== undefined,
    reconciliation,
    findings,
    findingsByFlow,
  };
}
