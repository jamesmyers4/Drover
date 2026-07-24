/**
 * Structured-output validation for the analyst tier (CLAUDE.md Session 5:
 * "malformed analyst output gets logged and skipped, never crashes the
 * pipeline"). Guards against a hallucinated `type`/`severity` enum value and
 * against session ids the model invented rather than copied from the
 * digests it was given.
 */

import type { CrossSessionFindingType, FindingSeverity } from "../types/index.js";
import type { RawCrossSessionFinding } from "./provider.js";

const VALID_TYPES: readonly CrossSessionFindingType[] = [
  "duplicate-label",
  "repeated-stumble-route",
  "slow-checkpoint",
  "recurring-dead-end",
];
const VALID_SEVERITIES: readonly FindingSeverity[] = ["low", "medium", "high", "critical"];

export interface ValidatedCrossSessionFinding {
  type: CrossSessionFindingType;
  severity: FindingSeverity;
  description: string;
  sessionIds: string[];
  route: string;
}

export interface ValidationError {
  error: string;
}

export function isValidationError(
  value: ValidatedCrossSessionFinding | ValidationError,
): value is ValidationError {
  return "error" in value;
}

function isType(value: unknown): value is CrossSessionFindingType {
  return typeof value === "string" && (VALID_TYPES as readonly string[]).includes(value);
}

function isSeverity(value: unknown): value is FindingSeverity {
  return typeof value === "string" && (VALID_SEVERITIES as readonly string[]).includes(value);
}

/** Validates one raw finding against the known set of session ids for this run. */
export function validateRawFinding(
  raw: RawCrossSessionFinding,
  knownSessionIds: ReadonlySet<string>,
): ValidatedCrossSessionFinding | ValidationError {
  if (!isType(raw.type)) {
    return { error: `invalid or missing "type": ${JSON.stringify(raw.type)}` };
  }
  if (!isSeverity(raw.severity)) {
    return { error: `invalid or missing "severity": ${JSON.stringify(raw.severity)}` };
  }
  if (typeof raw.description !== "string" || !raw.description.trim()) {
    return { error: 'missing or empty "description"' };
  }
  if (typeof raw.route !== "string" || !raw.route.trim()) {
    return { error: 'missing or empty "route"' };
  }
  if (!Array.isArray(raw.sessionIds)) {
    return { error: '"sessionIds" is not an array' };
  }
  const sessionIds = raw.sessionIds.filter(
    (id): id is string => typeof id === "string" && knownSessionIds.has(id),
  );
  if (sessionIds.length === 0) {
    return { error: '"sessionIds" contained no session id from this run\'s digests' };
  }

  return {
    type: raw.type,
    severity: raw.severity,
    description: raw.description.trim(),
    sessionIds,
    route: raw.route.trim(),
  };
}
