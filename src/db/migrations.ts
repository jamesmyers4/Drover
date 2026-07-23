/**
 * Versioned, forward-only migrations. Each entry runs once inside a
 * transaction; applied versions are recorded in `schema_migrations`.
 *
 * Schema principles (CONTEXT.md "Data capture & storage"):
 * - Raw timestamps only — no derived-metric columns.
 * - Findings live in two separate tables (in-session vs. cross-session).
 * - Finding status history is one row per finding per run, keyed by
 *   match_key, so "open for N runs" is a count on existing data.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "core-tables",
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        app_name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'budget-stopped', 'crashed')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        persona_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'hard-stopped', 'budget-capped')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX idx_sessions_run ON sessions(run_id);

      CREATE TABLE action_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        timestamp INTEGER NOT NULL,
        action_type TEXT NOT NULL,
        target TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        checkpoint_id TEXT
      );
      CREATE INDEX idx_action_events_session ON action_events(session_id, timestamp);

      CREATE TABLE in_session_findings (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        event_id TEXT NOT NULL REFERENCES action_events(id),
        type TEXT NOT NULL CHECK (type IN ('console-error', 'http-failure', 'action-budget-exhausted', 'hard-stop')),
        severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
        description TEXT NOT NULL,
        match_key TEXT NOT NULL,
        screenshot_path TEXT,
        trace_snippet TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_in_session_findings_session ON in_session_findings(session_id);
      CREATE INDEX idx_in_session_findings_match ON in_session_findings(match_key);

      CREATE TABLE cross_session_findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        type TEXT NOT NULL CHECK (type IN ('duplicate-label', 'repeated-stumble-route', 'slow-checkpoint', 'recurring-dead-end')),
        severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
        description TEXT NOT NULL,
        session_ids_json TEXT NOT NULL,
        match_key TEXT NOT NULL,
        screenshot_path TEXT,
        trace_snippet TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_cross_session_findings_run ON cross_session_findings(run_id);
      CREATE INDEX idx_cross_session_findings_match ON cross_session_findings(match_key);

      CREATE TABLE finding_status_history (
        match_key TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id),
        finding_kind TEXT NOT NULL CHECK (finding_kind IN ('in-session', 'cross-session')),
        finding_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('new', 'still-open', 'resolved')),
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (match_key, run_id)
      );
      CREATE INDEX idx_finding_status_match ON finding_status_history(match_key, status);
    `,
  },
];
