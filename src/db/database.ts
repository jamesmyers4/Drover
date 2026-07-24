/**
 * Drover's SQLite layer. Fully separate from any target app's database —
 * one file per Drover installation, portable, no server required.
 */

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  ActionEvent,
  CrossSessionFinding,
  FindingStatusRecord,
  InSessionFinding,
  PersonaSession,
  Run,
  SimConfig,
} from "../types/index.js";
import { migrations } from "./migrations.js";

export function newId(): string {
  return randomUUID();
}

/** An ActionEvent as stored: the row id is generated at insert time. */
export interface StoredActionEvent extends ActionEvent {
  id: string;
}

export class DroverDb {
  private readonly db: Database.Database;

  /** @param path SQLite file path, or ":memory:" for tests. */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const applied = new Set(
      this.db
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((r) => (r as { version: number }).version),
    );
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(m.version, m.name, Date.now());
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // --- runs ---

  insertRun(run: Run): void {
    this.db
      .prepare(
        "INSERT INTO runs (id, app_name, config_json, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        run.appName,
        JSON.stringify(run.config),
        run.status,
        run.startedAt,
        run.endedAt ?? null,
      );
  }

  updateRunStatus(id: string, status: Run["status"], endedAt?: number): void {
    this.db
      .prepare("UPDATE runs SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, endedAt ?? null, id);
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | {
          id: string;
          app_name: string;
          config_json: string;
          status: Run["status"];
          started_at: number;
          ended_at: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      appName: row.app_name,
      config: JSON.parse(row.config_json) as SimConfig,
      status: row.status,
      startedAt: row.started_at,
      ...(row.ended_at !== null && { endedAt: row.ended_at }),
    };
  }

  // --- sessions ---

  insertSession(session: PersonaSession): void {
    this.db
      .prepare(
        "INSERT INTO sessions (id, run_id, persona_id, goal_id, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        session.id,
        session.runId,
        session.personaId,
        session.goalId,
        session.status,
        session.startedAt,
        session.endedAt ?? null,
      );
  }

  updateSessionStatus(id: string, status: PersonaSession["status"], endedAt?: number): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, endedAt ?? null, id);
  }

  getSession(id: string): PersonaSession | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | {
          id: string;
          run_id: string;
          persona_id: string;
          goal_id: string;
          status: PersonaSession["status"];
          started_at: number;
          ended_at: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      runId: row.run_id,
      personaId: row.persona_id,
      goalId: row.goal_id,
      status: row.status,
      startedAt: row.started_at,
      ...(row.ended_at !== null && { endedAt: row.ended_at }),
    };
  }

  getSessionsByRun(runId: string): PersonaSession[] {
    const rows = this.db
      .prepare("SELECT id FROM sessions WHERE run_id = ? ORDER BY started_at")
      .all(runId) as { id: string }[];
    return rows.map((r) => this.getSession(r.id) as PersonaSession);
  }

  // --- action events ---

  /** Returns the generated event id so findings can reference it. */
  insertActionEvent(event: ActionEvent): string {
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO action_events (id, session_id, timestamp, action_type, target, reasoning, checkpoint_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        event.sessionId,
        event.timestamp,
        event.actionType,
        event.target,
        event.reasoning,
        event.checkpointId ?? null,
      );
    return id;
  }

  /**
   * Tags an already-inserted event with the checkpoint it satisfied. Needed
   * because checkpoint satisfaction is only known *after* a primitive's
   * effect lands on the page, but the event itself is written synchronously
   * during the primitive call — so this is a follow-up UPDATE, not part of
   * `insertActionEvent`.
   */
  updateActionEventCheckpoint(eventId: string, checkpointId: string): void {
    this.db
      .prepare("UPDATE action_events SET checkpoint_id = ? WHERE id = ?")
      .run(checkpointId, eventId);
  }

  getEventsBySession(sessionId: string): StoredActionEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM action_events WHERE session_id = ? ORDER BY timestamp, id")
      .all(sessionId) as {
      id: string;
      session_id: string;
      timestamp: number;
      action_type: string;
      target: string;
      reasoning: string;
      checkpoint_id: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      actionType: row.action_type,
      target: row.target,
      reasoning: row.reasoning,
      ...(row.checkpoint_id !== null && { checkpointId: row.checkpoint_id }),
    }));
  }

  // --- findings ---

  insertInSessionFinding(finding: InSessionFinding): void {
    this.db
      .prepare(
        "INSERT INTO in_session_findings (id, session_id, event_id, type, severity, description, match_key, screenshot_path, trace_snippet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        finding.id,
        finding.sessionId,
        finding.eventId,
        finding.type,
        finding.severity,
        finding.description,
        finding.matchKey,
        finding.screenshotPath ?? null,
        finding.traceSnippet ?? null,
        finding.createdAt,
      );
  }

  getInSessionFinding(id: string): InSessionFinding | undefined {
    const row = this.db.prepare("SELECT * FROM in_session_findings WHERE id = ?").get(id) as
      | {
          id: string;
          session_id: string;
          event_id: string;
          type: InSessionFinding["type"];
          severity: InSessionFinding["severity"];
          description: string;
          match_key: string;
          screenshot_path: string | null;
          trace_snippet: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      sessionId: row.session_id,
      eventId: row.event_id,
      type: row.type,
      severity: row.severity,
      description: row.description,
      matchKey: row.match_key,
      ...(row.screenshot_path !== null && { screenshotPath: row.screenshot_path }),
      ...(row.trace_snippet !== null && { traceSnippet: row.trace_snippet }),
      createdAt: row.created_at,
    };
  }

  insertCrossSessionFinding(finding: CrossSessionFinding): void {
    this.db
      .prepare(
        "INSERT INTO cross_session_findings (id, run_id, type, severity, description, session_ids_json, match_key, screenshot_path, trace_snippet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        finding.id,
        finding.runId,
        finding.type,
        finding.severity,
        finding.description,
        JSON.stringify(finding.sessionIds),
        finding.matchKey,
        finding.screenshotPath ?? null,
        finding.traceSnippet ?? null,
        finding.createdAt,
      );
  }

  getCrossSessionFindingsByRun(runId: string): CrossSessionFinding[] {
    const rows = this.db
      .prepare("SELECT id FROM cross_session_findings WHERE run_id = ? ORDER BY created_at")
      .all(runId) as { id: string }[];
    return rows.map((r) => this.getCrossSessionFinding(r.id) as CrossSessionFinding);
  }

  getInSessionFindingsBySession(sessionId: string): InSessionFinding[] {
    const rows = this.db
      .prepare("SELECT id FROM in_session_findings WHERE session_id = ? ORDER BY created_at")
      .all(sessionId) as { id: string }[];
    return rows.map((r) => this.getInSessionFinding(r.id) as InSessionFinding);
  }

  getCrossSessionFinding(id: string): CrossSessionFinding | undefined {
    const row = this.db.prepare("SELECT * FROM cross_session_findings WHERE id = ?").get(id) as
      | {
          id: string;
          run_id: string;
          type: CrossSessionFinding["type"];
          severity: CrossSessionFinding["severity"];
          description: string;
          session_ids_json: string;
          match_key: string;
          screenshot_path: string | null;
          trace_snippet: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      runId: row.run_id,
      type: row.type,
      severity: row.severity,
      description: row.description,
      sessionIds: JSON.parse(row.session_ids_json) as string[],
      matchKey: row.match_key,
      ...(row.screenshot_path !== null && { screenshotPath: row.screenshot_path }),
      ...(row.trace_snippet !== null && { traceSnippet: row.trace_snippet }),
      createdAt: row.created_at,
    };
  }

  // --- finding status history ---

  /**
   * Upsert, not insert-only: the analyst tier (Session 5) reconciles a run a
   * second time once cross-session findings exist for it (they don't exist
   * yet when the orchestrator's own post-run reconciliation runs, since the
   * analyst is a separate, later command) — the second pass must be able to
   * overwrite the first pass's row for the same (match_key, run_id) rather
   * than violating its primary key.
   */
  recordFindingStatus(record: FindingStatusRecord): void {
    this.db
      .prepare(
        `INSERT INTO finding_status_history (match_key, run_id, finding_kind, finding_id, status, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_key, run_id) DO UPDATE SET
           finding_kind = excluded.finding_kind,
           finding_id = excluded.finding_id,
           status = excluded.status,
           recorded_at = excluded.recorded_at`,
      )
      .run(
        record.matchKey,
        record.runId,
        record.findingKind,
        record.findingId,
        record.status,
        record.recordedAt,
      );
  }

  getStatusHistory(matchKey: string): FindingStatusRecord[] {
    const rows = this.db
      .prepare(
        // rowid tiebreak: recorded_at is caller-supplied wall-clock time and
        // can tie under fast automated writes (e.g. back-to-back runs in a
        // test or a scripted batch) — rowid preserves true insertion order.
        "SELECT * FROM finding_status_history WHERE match_key = ? ORDER BY recorded_at, rowid",
      )
      .all(matchKey) as {
      match_key: string;
      run_id: string;
      finding_kind: FindingStatusRecord["findingKind"];
      finding_id: string;
      status: FindingStatusRecord["status"];
      recorded_at: number;
    }[];
    return rows.map((row) => ({
      matchKey: row.match_key,
      runId: row.run_id,
      findingKind: row.finding_kind,
      findingId: row.finding_id,
      status: row.status,
      recordedAt: row.recorded_at,
    }));
  }

  /** "How many runs has this finding been open" — a count on existing data. */
  countOpenRuns(matchKey: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM finding_status_history WHERE match_key = ? AND status IN ('new', 'still-open')",
      )
      .get(matchKey) as { n: number };
    return row.n;
  }

  /**
   * Every match_key this app's *other* runs have ever recorded status for —
   * the orchestrator's reconciliation (Session 4) diffs this against the
   * current run's findings to detect resolved ones (open previously, absent
   * now). Joins through `runs` since finding_status_history has no app_name
   * column of its own.
   */
  getPriorMatchKeysForApp(appName: string, excludeRunId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT h.match_key AS match_key FROM finding_status_history h
         JOIN runs r ON r.id = h.run_id
         WHERE r.app_name = ? AND h.run_id != ?`,
      )
      .all(appName, excludeRunId) as { match_key: string }[];
    return rows.map((r) => r.match_key);
  }

  /** The most recent status record for a match_key from one of this app's other runs. */
  getLatestStatusForMatchKeyExcludingRun(
    appName: string,
    matchKey: string,
    excludeRunId: string,
  ): FindingStatusRecord | undefined {
    const row = this.db
      .prepare(
        // rowid tiebreak — see getStatusHistory's comment.
        `SELECT h.* FROM finding_status_history h
         JOIN runs r ON r.id = h.run_id
         WHERE r.app_name = ? AND h.match_key = ? AND h.run_id != ?
         ORDER BY h.recorded_at DESC, h.rowid DESC LIMIT 1`,
      )
      .get(appName, matchKey, excludeRunId) as
      | {
          match_key: string;
          run_id: string;
          finding_kind: FindingStatusRecord["findingKind"];
          finding_id: string;
          status: FindingStatusRecord["status"];
          recorded_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      matchKey: row.match_key,
      runId: row.run_id,
      findingKind: row.finding_kind,
      findingId: row.finding_id,
      status: row.status,
      recordedAt: row.recorded_at,
    };
  }
}
