/**
 * Turn digests + chunking for the cross-turn pass (CTS.md Soak Session 6) —
 * the soak-mode analogue of `buildSessionDigest`'s role for the Analyst
 * tier, architecturally mirrored rather than code-shared (ADR 0008: a turn
 * isn't a session). Unlike `buildSessionDigest`, this needs no `db`
 * parameter at all — a `TurnRecord` already carries everything a digest
 * needs directly (request/response payload, timing, error state); nothing
 * here requires a separate join the way sessions/events/findings do.
 */

import type { TurnRecord } from "./types.js";

/** Caps how much of a turn's request/response JSON lands in the cross-turn prompt — same "capped trace" precedent `SessionDigest.actionsSummary` already sets, so one enormous payload can't blow up a chunk's prompt size. */
const MAX_PAYLOAD_SUMMARY_CHARS = 2000;

export interface TurnDigest {
  turnId: string;
  sequence: number;
  lane: string;
  variationId: string;
  /** Raw epoch milliseconds. */
  timestamp: number;
  responseTimeMs?: number;
  httpStatus?: number;
  explicitError: boolean;
  errorDetail?: string;
  /** Truncated JSON of the turn's request payload. */
  requestSummary: string;
  /** Truncated JSON of the turn's response payload — absent if none was ever received (e.g. a variation failure short-circuited before HTTP dispatch). */
  responseSummary?: string;
}

function summarizePayload(value: unknown): string {
  const json = JSON.stringify(value) ?? "undefined";
  return json.length > MAX_PAYLOAD_SUMMARY_CHARS
    ? `${json.slice(0, MAX_PAYLOAD_SUMMARY_CHARS)}…`
    : json;
}

export function buildTurnDigest(turn: TurnRecord): TurnDigest {
  return {
    turnId: turn.id,
    sequence: turn.sequence,
    lane: turn.lane,
    variationId: turn.variationId,
    timestamp: turn.timestamp,
    ...(turn.responseTimeMs !== undefined && { responseTimeMs: turn.responseTimeMs }),
    ...(turn.httpStatus !== undefined && { httpStatus: turn.httpStatus }),
    explicitError: turn.explicitError ?? false,
    ...(turn.errorDetail !== undefined && { errorDetail: turn.errorDetail }),
    requestSummary: summarizePayload(turn.requestPayload),
    ...(turn.responsePayload !== undefined && {
      responseSummary: summarizePayload(turn.responsePayload),
    }),
  };
}

/**
 * Chosen as a round number comfortably larger than any run this v1 has
 * actually been exercised against — same flagged-guess precedent
 * `DEFAULT_SESSIONS_PER_CHUNK` already set for the Analyst tier (25
 * sessions); a soak run's turn count over hours can run far higher than a
 * discovery run's session count, so this starts larger. Revisit once a real
 * soak run's turn volume gives a real number to derive it from.
 */
export const DEFAULT_TURNS_PER_CHUNK = 50;

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (!(size > 0)) {
    throw new Error(`turnsPerChunk must be a positive number, got ${size}.`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
