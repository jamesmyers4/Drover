/**
 * Versioned migrations for `soak.sqlite` — Soak mode's own schema, no FK to
 * Drover's primary db or to Grader's `grader.sqlite` (`soak_runs` here is the
 * Soak-side analogue of `runs`/`grading_runs`, not the same table). Applied
 * by `SoakDb` via the generic `SqliteStore` runner (`src/db/sqlite-store.ts`),
 * the same runner `DroverDb` and `GraderDb` both use against their own file
 * and migration set (ADR 0007).
 *
 * Schema decisions (CTS.md "Soak Session 1"):
 * - `soak_runs.status`: running|completed|budget-stopped|crashed — mirrors
 *   `RunStatus` exactly (no per-turn "session" concept the way Discovery
 *   mode has hard-stopped/budget-capped sessions; a soak run's own turns
 *   absorb explicit errors inline without ending the run — see `turns`).
 * - `soak_runs.blueprint_config_json`: a full snapshot of the resolved
 *   SoakBlueprint (minus `teardown`, which isn't serializable) — not named
 *   in CTS.md's literal column list (which only names `blueprintVersion`),
 *   added alongside it so `drover soak report` (Session 7) can render the
 *   pacing range/pipeline budgets/pool names an already-finished run
 *   actually used without re-opening the blueprint file. Mirrors
 *   `runs.config_json`/`grading_runs.pack_config_json`'s identical role for
 *   the other two subsystems.
 * - `turns.explicit_error`: stored as 0/1 (SQLite has no native boolean) —
 *   a 402/429 the blueprint treats as expected gating is NOT this (ADR 0006).
 * - `metrics`: open-ended name/value rows rather than fixed columns, so a
 *   new metric (a percentile, a load stat) never needs its own migration.
 */

import type { Migration } from "../db/sqlite-store.js";

export const soakMigrations: Migration[] = [
  {
    version: 1,
    name: "soak-core-tables",
    sql: `
      CREATE TABLE soak_runs (
        id TEXT PRIMARY KEY,
        app_name TEXT NOT NULL,
        blueprint_version TEXT NOT NULL,
        driver_model TEXT NOT NULL,
        target_base_url TEXT NOT NULL,
        blueprint_config_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'budget-stopped', 'crashed')),
        budget_ceiling_usd REAL NOT NULL,
        spent_usd REAL NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES soak_runs(id),
        sequence INTEGER NOT NULL,
        lane TEXT NOT NULL,
        variation_id TEXT NOT NULL,
        request_payload_json TEXT NOT NULL,
        response_payload_json TEXT,
        response_time_ms INTEGER,
        http_status INTEGER,
        explicit_error INTEGER NOT NULL DEFAULT 0 CHECK (explicit_error IN (0, 1)),
        error_detail TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX idx_turns_run ON turns(run_id);
      CREATE INDEX idx_turns_run_sequence ON turns(run_id, sequence);

      CREATE TABLE metrics (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES soak_runs(id),
        name TEXT NOT NULL,
        value REAL NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX idx_metrics_run ON metrics(run_id);
      CREATE INDEX idx_metrics_run_name ON metrics(run_id, name);
    `,
  },
  {
    version: 2,
    name: "soak-analysis-tables",
    // CTS.md Session 7: `drover soak analyze` persists both analysis
    // passes' findings. `grading_run_id` is a soft reference only (no real
    // FK possible across separate SQLite files) to a Grader `GradingRun.id`
    // in `grader.sqlite` — overwritten, not accumulated, on each
    // re-analysis (Drover doesn't track multi-pass Grader history for a
    // soak run any more than it does for a Discovery run's analyst pass).
    // No `grader_cost_usd` column: Grader itself doesn't track cost per
    // Grading Run yet (GAPS.md), so there's nothing real to store there.
    sql: `
      ALTER TABLE soak_runs ADD COLUMN grading_run_id TEXT;
      ALTER TABLE soak_runs ADD COLUMN cross_turn_cost_usd REAL;

      CREATE TABLE cross_turn_findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES soak_runs(id),
        type TEXT NOT NULL CHECK (type IN ('disagreement', 'drift', 'recurring-error-cluster', 'timing-anomaly')),
        severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
        description TEXT NOT NULL,
        turn_ids_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_cross_turn_findings_run ON cross_turn_findings(run_id);
    `,
  },
];
