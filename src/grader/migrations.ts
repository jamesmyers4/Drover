/**
 * Versioned migrations for `grader.sqlite` — Grader's own schema, no FK to
 * Drover's primary db (`grading_runs` here is the Grader-side analogue of
 * `runs`, not the same table). Applied by `GraderDb` via the generic
 * `SqliteStore` runner (`src/db/sqlite-store.ts`), the same runner
 * `DroverDb` uses against its own file and migration set.
 *
 * Schema decisions (FUTUREPLAN.md "Grader Session 1"):
 * - `tasks.status`: pending|running|pass|fail|skipped — skipped is
 *   first-class, never conflated with fail.
 * - `tasks.model_family`/`tasks.execution_target`: separate nullable
 *   columns, LLM-backed Tasks only (ADR 0003, ADR 0004) — do not conflate.
 * - `tasks.checks_json`: each Check's score *and* reasoning, not the score
 *   alone (Q11) — a Task can score several Checks in one pass.
 * - `tasks.rubric_snapshot_json`: resolved at dispatch, persisted at
 *   write-time (Q8).
 * - `consensus_rounds`: a real table storing the resolved outcome per Check,
 *   not a computed grouping recomputed from raw votes on every read.
 */

import type { Migration } from "../db/sqlite-store.js";

export const graderMigrations: Migration[] = [
  {
    version: 1,
    name: "grader-core-tables",
    sql: `
      CREATE TABLE grading_runs (
        id TEXT PRIMARY KEY,
        app_name TEXT NOT NULL,
        pack_config_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'budget-stopped', 'crashed')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE cases (
        id TEXT PRIMARY KEY,
        grading_run_id TEXT NOT NULL REFERENCES grading_runs(id),
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        rubric_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_cases_grading_run ON cases(grading_run_id);

      CREATE TABLE consensus_rounds (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        layer_id INTEGER NOT NULL,
        check_resolutions_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX idx_consensus_rounds_case ON consensus_rounds(case_id);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        layer_id INTEGER NOT NULL,
        consensus_round_id TEXT REFERENCES consensus_rounds(id),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'pass', 'fail', 'skipped')),
        model_family TEXT,
        execution_target TEXT,
        rubric_snapshot_json TEXT,
        checks_json TEXT NOT NULL DEFAULT '[]',
        skipped_reason TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX idx_tasks_case ON tasks(case_id);
      CREATE INDEX idx_tasks_consensus_round ON tasks(consensus_round_id);
    `,
  },
];
