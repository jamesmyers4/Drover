/**
 * Reads the key rows a `runDiscovery` call produced and flattens them into a
 * stable, sorted, JSON-serializable shape for golden comparison (TESTING.md
 * Session 3) — never a raw SQLite dump, since row insertion order and real
 * ids/timestamps aren't meaningful signal here.
 *
 * Deliberately excludes: row ids, timestamps, screenshot paths, trace
 * snippets, and free-text `reasoning`/`description` strings. Those are
 * either inherently nondeterministic (ids, timestamps) or just prose that
 * could reasonably change without any real behavioral regression (wording
 * tweaks shouldn't force a golden-file update). `matchKey` is kept as-is —
 * it's already host/port-independent by construction
 * (`src/matching/match-key.ts`'s `normalizeRoute` strips origin/query/hash).
 *
 * `events` is also deliberately narrowed to *primitive* actions
 * (navigate/click/fill) only — passive observation events
 * (`console-error`/`http-failure`/`page-error`) and `action-error` are
 * excluded. Confirmed by actually hitting it (see TESTING.md's Session 3
 * decisions log): a failed navigate's synchronous `action-error` (logged
 * from `performAction`'s catch block) and Playwright's async
 * `requestfailed`-driven `http-failure` observation for that same failure
 * are two independent listeners with no fixed relative order — they can
 * land in either order, sometimes within the same millisecond, and no
 * amount of re-sorting makes that deterministic because the *real* order
 * genuinely varies run to run. Their relative order isn't meaningful
 * behavior to lock down anyway; the `findings` list below (already
 * deduped/sorted) is what actually matters for regression coverage of
 * errors, and it's unaffected by this race.
 */

import type { DroverDb } from "../../src/db/database.js";
import type { RunDiscoveryResult } from "../../src/orchestrator/run-discovery.js";

const PRIMITIVE_ACTION_TYPES = new Set(["navigate", "click", "fill"]);

export interface RunDumpEvent {
  actionType: string;
  target: string;
  checkpointId?: string;
}

export interface RunDumpFinding {
  type: string;
  severity: string;
  matchKey: string;
}

export interface RunDumpSession {
  personaId: string;
  goalId: string;
  status: string;
  events: RunDumpEvent[];
  findings: RunDumpFinding[];
}

export interface RunDump {
  run: {
    status: string;
    sessionsScheduled: number;
    sessionsCompleted: number;
    sessionsHardStopped: number;
    sessionsBudgetCapped: number;
    sessionsErrored: number;
    totalCostUsd: number;
    reconciliation: { new: number; stillOpen: number; resolved: number };
  };
  sessions: RunDumpSession[];
}

function sortKey(a: { personaId: string; goalId: string }): string {
  return `${a.personaId}:${a.goalId}`;
}

function findingSortKey(f: RunDumpFinding): string {
  return `${f.type}:${f.matchKey}`;
}

export function dumpRun(db: DroverDb, result: RunDiscoveryResult): RunDump {
  const sessions: RunDumpSession[] = db
    .getSessionsByRun(result.runId)
    .map((session) => ({
      personaId: session.personaId,
      goalId: session.goalId,
      status: session.status,
      events: db
        .getEventsBySession(session.id)
        .filter((event) => PRIMITIVE_ACTION_TYPES.has(event.actionType))
        .map((event) => ({
          actionType: event.actionType,
          target: event.target,
          ...(event.checkpointId !== undefined && { checkpointId: event.checkpointId }),
        })),
      findings: db
        .getInSessionFindingsBySession(session.id)
        .map((finding) => ({
          type: finding.type,
          severity: finding.severity,
          matchKey: finding.matchKey,
        }))
        .sort((a, b) => findingSortKey(a).localeCompare(findingSortKey(b))),
    }))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  return {
    run: {
      status: result.status,
      sessionsScheduled: result.sessionsScheduled,
      sessionsCompleted: result.sessionsCompleted,
      sessionsHardStopped: result.sessionsHardStopped,
      sessionsBudgetCapped: result.sessionsBudgetCapped,
      sessionsErrored: result.sessionsErrored,
      totalCostUsd: result.totalCostUsd,
      reconciliation: result.reconciliation,
    },
    sessions,
  };
}
