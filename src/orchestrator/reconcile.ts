/**
 * Cross-run finding status reconciliation (CONTEXT.md "Data capture &
 * storage": every finding carries `new | still-open | resolved`; CLAUDE.md
 * Session 4). Runs once after a run's sessions finish: every match_key seen
 * in this run gets tagged `new` (never seen before, for this app) or
 * `still-open` (some other run of this app already recorded it); every
 * match_key that was open going into this run but wasn't seen this run gets
 * tagged `resolved`. A match_key already resolved is left alone rather than
 * re-flagged every run it stays absent.
 *
 * Called twice per run, at two different points where cross-session finding
 * data completeness differs (GAPS.md's "two-phase reconciliation" entry):
 * once by `runDiscovery` right after a run's sessions finish (only
 * in-session findings exist yet — `drover analyze` hasn't run), and again by
 * `runAnalyst` after cross-session findings have been written for the run.
 * A cross-session-typed match_key that's absent from `seenThisRun` during
 * the first call doesn't mean it's actually resolved — it may just not have
 * been re-detected yet because the analyst hasn't looked. So the first call
 * passes `crossSessionDataComplete: false` to leave prior open
 * cross-session-typed match_keys untouched (neither resolved nor
 * re-flagged) until the second, fuller call — which is the only one with
 * real information about whether this run's cross-session findings recur.
 */

import type { DroverDb } from "../db/database.js";
import type { FindingStatus } from "../types/index.js";

export interface ReconciliationSummary {
  new: number;
  stillOpen: number;
  resolved: number;
}

export interface ReconcileOptions {
  /**
   * Whether this call has complete cross-session finding data for the run
   * (i.e. `drover analyze` has already run and written this run's
   * `cross_session_findings`). Defaults to `true` — the common case for a
   * standalone call. `runDiscovery` explicitly passes `false` for its
   * post-run call, since at that point cross-session findings for this run
   * can't exist yet by construction.
   *
   * @default true
   */
  crossSessionDataComplete?: boolean;
}

interface SeenFinding {
  kind: "in-session" | "cross-session";
  findingId: string;
}

export function reconcileRunFindings(
  db: DroverDb,
  runId: string,
  appName: string,
  options?: ReconcileOptions,
): ReconciliationSummary {
  const crossSessionDataComplete = options?.crossSessionDataComplete ?? true;
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
    if (priorLatest.findingKind === "cross-session" && !crossSessionDataComplete) continue;
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
