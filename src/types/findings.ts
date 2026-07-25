/**
 * Findings — two separate tables, not one (CONTEXT.md "Data capture & storage"):
 * in-session findings are caught live by the actor and reference a single event;
 * cross-session findings only exist after the analyst tier runs and reference a
 * set of sessions.
 */

/** Status of a finding relative to prior runs. */
export type FindingStatus = "new" | "still-open" | "resolved";

export type FindingSeverity = "low" | "medium" | "high" | "critical";

/** What the actor can flag live, mid-session. */
export type InSessionFindingType =
  | "console-error"
  | "http-failure"
  | "page-error"
  | "action-budget-exhausted"
  | "hard-stop";

export interface InSessionFinding {
  id: string;
  sessionId: string;
  /** The single ActionEvent this finding is anchored to. */
  eventId: string;
  type: InSessionFindingType;
  severity: FindingSeverity;
  description: string;
  /**
   * Cross-run identity key used for status reconciliation. The exact
   * computation is defined in Session 4 (planned: finding type + normalized
   * route + target identifier); the column exists from day one so status
   * history has a stable join key.
   */
  matchKey: string;
  /** Captured only at the moment the finding fires. */
  screenshotPath?: string;
  traceSnippet?: string;
  /** Raw epoch milliseconds. */
  createdAt: number;
}

/** What the analyst tier can surface across sessions. */
export type CrossSessionFindingType =
  | "duplicate-label"
  | "repeated-stumble-route"
  | "slow-checkpoint"
  | "recurring-dead-end";

export interface CrossSessionFinding {
  id: string;
  runId: string;
  type: CrossSessionFindingType;
  severity: FindingSeverity;
  description: string;
  /** The set of sessions this pattern was observed across. */
  sessionIds: string[];
  /** See InSessionFinding.matchKey. */
  matchKey: string;
  screenshotPath?: string;
  traceSnippet?: string;
  /** Raw epoch milliseconds. */
  createdAt: number;
}

/**
 * One row per finding per run — makes "open for N runs" a count on existing
 * data (the future auto-promotion rule needs no new instrumentation).
 */
export interface FindingStatusRecord {
  matchKey: string;
  runId: string;
  findingKind: "in-session" | "cross-session";
  findingId: string;
  status: FindingStatus;
  /** Raw epoch milliseconds. */
  recordedAt: number;
}
