/**
 * Structured-output validation for the cross-turn pass (CTS.md Soak Session
 * 6) — mirrors the Analyst tier's `validate.ts` discipline ("malformed
 * output gets logged and skipped, never crashes the pipeline"). Guards
 * against a hallucinated `type`/`severity` enum value and against turn ids
 * the model invented rather than copied from the digests it was given.
 */

import type { FindingSeverity } from "../types/index.js";
import type { RawCrossTurnFinding } from "./cross-turn-provider.js";
import type { CrossTurnFinding, CrossTurnFindingType } from "./types.js";

/** The three LLM-derived categories — `timing-anomaly` is computed deterministically (`cross-turn.ts`) and never appears in a raw model response. */
const VALID_TYPES: readonly CrossTurnFindingType[] = [
  "disagreement",
  "drift",
  "recurring-error-cluster",
];
const VALID_SEVERITIES: readonly FindingSeverity[] = ["low", "medium", "high", "critical"];

export interface CrossTurnValidationError {
  error: string;
}

export function isCrossTurnValidationError(
  value: CrossTurnFinding | CrossTurnValidationError,
): value is CrossTurnValidationError {
  return "error" in value;
}

function isType(value: unknown): value is CrossTurnFindingType {
  return typeof value === "string" && (VALID_TYPES as readonly string[]).includes(value);
}

function isSeverity(value: unknown): value is FindingSeverity {
  return typeof value === "string" && (VALID_SEVERITIES as readonly string[]).includes(value);
}

/** Validates one raw finding against the known set of turn ids for this batch. */
export function validateRawCrossTurnFinding(
  raw: RawCrossTurnFinding,
  knownTurnIds: ReadonlySet<string>,
): CrossTurnFinding | CrossTurnValidationError {
  if (!isType(raw.type)) {
    return { error: `invalid or missing "type": ${JSON.stringify(raw.type)}` };
  }
  if (!isSeverity(raw.severity)) {
    return { error: `invalid or missing "severity": ${JSON.stringify(raw.severity)}` };
  }
  if (typeof raw.description !== "string" || !raw.description.trim()) {
    return { error: 'missing or empty "description"' };
  }
  if (!Array.isArray(raw.turnIds)) {
    return { error: '"turnIds" is not an array' };
  }
  const turnIds = raw.turnIds.filter(
    (id): id is string => typeof id === "string" && knownTurnIds.has(id),
  );
  if (turnIds.length === 0) {
    return { error: '"turnIds" contained no turn id from this batch\'s digests' };
  }

  return {
    type: raw.type,
    severity: raw.severity,
    description: raw.description.trim(),
    turnIds,
  };
}
