/**
 * Cross-run finding status reconciliation (CONTEXT.md "Data capture &
 * storage": every finding carries `new | still-open | resolved`; CLAUDE.md
 * Session 4). Runs once after a run's sessions finish: every match_key seen
 * in this run gets tagged `new` (never seen before, for this app) or
 * `still-open` (some other run of this app already recorded it); every
 * match_key that was open going into this run but wasn't seen this run gets
 * tagged `resolved`. A match_key already resolved is left alone rather than
 * re-flagged every run it stays absent.
 */

import type { DroverDb } from "../db/database.js";
import type { FindingStatus } from "../types/index.js";

export interface ReconciliationSummary {
  new: number;
  stillOpen: number;
  resolved: number;
}

interface SeenFinding {
  kind: "in-session" | "cross-session";
  findingId: string;
}

export function reconcileRunFindings(
  db: DroverDb,
  runId: string,
  appName: string,
): ReconciliationSummary {
  const now = Date.now();
  const sessions = db.getSessionsByRun(runId);
  const seenThisRun = new Map<string, SeenFinding>();

  for (const session of sessions) {
    for (const finding of db.getInSessionFindingsBySession(session.id)) {
      seenThisRun.set(finding.matchKey, { kind: "in-session", findingId: finding.id });
    }
  }
  for (const finding of db.getCrossSessionFindingsByRun(runId)) {
    seenThisRun.set(finding.matchKey, { kind: "cross-session", findingId: finding.id });
  }

  const summary: ReconciliationSummary = { new: 0, stillOpen: 0, resolved: 0 };

  for (const [matchKey, seen] of seenThisRun) {
    const priorLatest = db.getLatestStatusForMatchKeyExcludingRun(appName, matchKey, runId);
    const status: FindingStatus = priorLatest ? "still-open" : "new";
    db.recordFindingStatus({
      matchKey,
      runId,
      findingKind: seen.kind,
      findingId: seen.findingId,
      status,
      recordedAt: now,
    });
    if (status === "new") summary.new++;
    else summary.stillOpen++;
  }

  for (const matchKey of db.getPriorMatchKeysForApp(appName, runId)) {
    if (seenThisRun.has(matchKey)) continue;
    const priorLatest = db.getLatestStatusForMatchKeyExcludingRun(appName, matchKey, runId);
    if (!priorLatest || priorLatest.status === "resolved") continue;
    db.recordFindingStatus({
      matchKey,
      runId,
      findingKind: priorLatest.findingKind,
      findingId: priorLatest.findingId,
      status: "resolved",
      recordedAt: now,
    });
    summary.resolved++;
  }

  return summary;
}
