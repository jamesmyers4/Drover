/**
 * Per-session digests fed to the analyst tier (CONTEXT.md "Architecture:
 * three tiers" — Analyst; CLAUDE.md Session 5). Derived metrics
 * (time-to-first-action, time-stuck) are computed here from raw event
 * timestamps, never stored as schema columns (CONTEXT.md "Data capture &
 * storage").
 *
 * `checkpointReachTimesMs` is computed from `ActionEvent.checkpointId`,
 * which the actor loop populates on the event whose action newly satisfied a
 * checkpoint (see `src/actor/loop.ts`) — this gives the analyst true
 * per-checkpoint elapsed time (checkpoint-reach timestamp minus session
 * start) instead of the older whole-session-duration-by-goal proxy. It
 * doesn't need the originating `Goal`/`Checkpoint` definitions (descriptions,
 * ordering) since `runAnalyst` only has the run's `SimConfig` snapshot, not
 * the domain pack itself — checkpoint ids alone are enough for the analyst
 * to compare the same checkpoint's reach time across sessions sharing a
 * `goalId`.
 */

import type { DroverDb } from "../db/database.js";
import type { PersonaSession } from "../types/index.js";

const MAX_ACTIONS_IN_DIGEST = 40;

export interface SessionDigest {
  sessionId: string;
  personaId: string;
  goalId: string;
  status: PersonaSession["status"];
  actionCount: number;
  /** Time from session start to its first logged action, in ms. */
  timeToFirstActionMs?: number;
  /** Time from session start to its end (or last event, if still "running"), in ms. */
  totalDurationMs?: number;
  /** Longest gap between two consecutive events, in ms — a "time stuck" proxy. */
  longestGapMs?: number;
  /**
   * Elapsed ms from session start to the first event tagged with each
   * checkpoint id this session reached — true per-checkpoint reach latency,
   * keyed by checkpoint id. Empty if the session reached no checkpoints.
   */
  checkpointReachTimesMs: Record<string, number>;
  /** "type (severity): description" lines, one per in-session finding. */
  findingsSummary: string[];
  /** "[actionType] target — reasoning" lines, truncated for very long sessions. */
  actionsSummary: string[];
}

export function buildSessionDigest(db: DroverDb, session: PersonaSession): SessionDigest {
  const events = db.getEventsBySession(session.id);
  const findings = db.getInSessionFindingsBySession(session.id);

  const firstEvent = events[0];
  const timeToFirstActionMs = firstEvent ? firstEvent.timestamp - session.startedAt : undefined;

  const lastEvent = events[events.length - 1];
  const endTimestamp = session.endedAt ?? lastEvent?.timestamp;
  const totalDurationMs = endTimestamp !== undefined ? endTimestamp - session.startedAt : undefined;

  let longestGapMs: number | undefined;
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    if (!prev || !cur) continue;
    const gap = cur.timestamp - prev.timestamp;
    if (longestGapMs === undefined || gap > longestGapMs) longestGapMs = gap;
  }

  const checkpointReachTimesMs: Record<string, number> = {};
  for (const event of events) {
    if (event.checkpointId && !(event.checkpointId in checkpointReachTimesMs)) {
      checkpointReachTimesMs[event.checkpointId] = event.timestamp - session.startedAt;
    }
  }

  const truncated = events.length > MAX_ACTIONS_IN_DIGEST;
  const shown = truncated ? events.slice(0, MAX_ACTIONS_IN_DIGEST) : events;
  const actionsSummary = shown.map((e) => `[${e.actionType}] ${e.target} — ${e.reasoning}`);
  if (truncated) {
    actionsSummary.push(`… ${events.length - MAX_ACTIONS_IN_DIGEST} more action(s) omitted …`);
  }

  const findingsSummary = findings.map((f) => `${f.type} (${f.severity}): ${f.description}`);

  return {
    sessionId: session.id,
    personaId: session.personaId,
    goalId: session.goalId,
    status: session.status,
    actionCount: events.length,
    ...(timeToFirstActionMs !== undefined && { timeToFirstActionMs }),
    ...(totalDurationMs !== undefined && { totalDurationMs }),
    ...(longestGapMs !== undefined && { longestGapMs }),
    checkpointReachTimesMs,
    findingsSummary,
    actionsSummary,
  };
}
