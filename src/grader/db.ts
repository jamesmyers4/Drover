/**
 * Grader's SQLite layer — `grader.sqlite`, fully separate from Drover's
 * primary db (own file, own schema, no FK to `runs`/`sessions`/
 * `action_events`). Built on the same generic `SqliteStore` runner
 * `DroverDb` uses (`src/db/sqlite-store.ts`), parameterized over Grader's
 * own migration set (`src/grader/migrations.ts`) — the storage-layer
 * generalization this module exists to prove out (FUTUREPLAN.md Grader
 * Session 1).
 */

import { randomUUID } from "node:crypto";
import { SqliteStore } from "../db/sqlite-store.js";
import { graderMigrations } from "./migrations.js";
import type {
  Case,
  CheckResolution,
  CheckResult,
  ConsensusRound,
  GraderPackConfigSnapshot,
  GradingRun,
  GradingRunStatus,
  LayerId,
  RubricSnapshot,
  Task,
  TaskStatus,
} from "./types.js";

export function newGraderId(): string {
  return randomUUID();
}

export class GraderDb extends SqliteStore {
  /** @param path SQLite file path, or ":memory:" for tests. */
  constructor(path: string) {
    super(path, graderMigrations);
  }

  // --- grading runs ---

  insertGradingRun(run: GradingRun): void {
    this.db
      .prepare(
        "INSERT INTO grading_runs (id, app_name, pack_config_json, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        run.appName,
        JSON.stringify(run.packConfig),
        run.status,
        run.startedAt,
        run.endedAt ?? null,
      );
  }

  updateGradingRunStatus(id: string, status: GradingRunStatus, endedAt?: number): void {
    this.db
      .prepare("UPDATE grading_runs SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, endedAt ?? null, id);
  }

  getGradingRun(id: string): GradingRun | undefined {
    const row = this.db.prepare("SELECT * FROM grading_runs WHERE id = ?").get(id) as
      | {
          id: string;
          app_name: string;
          pack_config_json: string;
          status: GradingRunStatus;
          started_at: number;
          ended_at: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      appName: row.app_name,
      packConfig: JSON.parse(row.pack_config_json) as GraderPackConfigSnapshot,
      status: row.status,
      startedAt: row.started_at,
      ...(row.ended_at !== null && { endedAt: row.ended_at }),
    };
  }

  // --- cases ---

  insertCase(c: Case): void {
    this.db
      .prepare(
        "INSERT INTO cases (id, grading_run_id, input_json, output_json, rubric_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        c.id,
        c.gradingRunId,
        JSON.stringify(c.input),
        JSON.stringify(c.output),
        c.rubric,
        c.createdAt,
      );
  }

  private mapCaseRow(row: {
    id: string;
    grading_run_id: string;
    input_json: string;
    output_json: string;
    rubric_key: string;
    created_at: number;
  }): Case {
    return {
      id: row.id,
      gradingRunId: row.grading_run_id,
      input: JSON.parse(row.input_json) as unknown,
      output: JSON.parse(row.output_json) as unknown,
      rubric: row.rubric_key,
      createdAt: row.created_at,
    };
  }

  getCase(id: string): Case | undefined {
    const row = this.db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as
      | {
          id: string;
          grading_run_id: string;
          input_json: string;
          output_json: string;
          rubric_key: string;
          created_at: number;
        }
      | undefined;
    return row ? this.mapCaseRow(row) : undefined;
  }

  getCasesByGradingRun(gradingRunId: string): Case[] {
    const rows = this.db
      .prepare("SELECT * FROM cases WHERE grading_run_id = ? ORDER BY created_at, rowid")
      .all(gradingRunId) as {
      id: string;
      grading_run_id: string;
      input_json: string;
      output_json: string;
      rubric_key: string;
      created_at: number;
    }[];
    return rows.map((row) => this.mapCaseRow(row));
  }

  // --- consensus rounds ---

  insertConsensusRound(round: ConsensusRound): void {
    this.db
      .prepare(
        "INSERT INTO consensus_rounds (id, case_id, layer_id, check_resolutions_json, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        round.id,
        round.caseId,
        round.layerId,
        JSON.stringify(round.checkResolutions),
        round.createdAt,
        round.resolvedAt ?? null,
      );
  }

  /** Writes every Check's final resolution at once — a Round resolves as a unit once every disputed Check's escalation (if any) has completed. */
  resolveConsensusRound(id: string, checkResolutions: CheckResolution[], resolvedAt: number): void {
    this.db
      .prepare(
        "UPDATE consensus_rounds SET check_resolutions_json = ?, resolved_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(checkResolutions), resolvedAt, id);
  }

  private mapConsensusRoundRow(row: {
    id: string;
    case_id: string;
    layer_id: number;
    check_resolutions_json: string;
    created_at: number;
    resolved_at: number | null;
  }): ConsensusRound {
    return {
      id: row.id,
      caseId: row.case_id,
      layerId: row.layer_id as LayerId,
      checkResolutions: JSON.parse(row.check_resolutions_json) as CheckResolution[],
      createdAt: row.created_at,
      ...(row.resolved_at !== null && { resolvedAt: row.resolved_at }),
    };
  }

  getConsensusRound(id: string): ConsensusRound | undefined {
    const row = this.db.prepare("SELECT * FROM consensus_rounds WHERE id = ?").get(id) as
      | {
          id: string;
          case_id: string;
          layer_id: number;
          check_resolutions_json: string;
          created_at: number;
          resolved_at: number | null;
        }
      | undefined;
    return row ? this.mapConsensusRoundRow(row) : undefined;
  }

  getConsensusRoundsByCase(caseId: string): ConsensusRound[] {
    const rows = this.db
      .prepare("SELECT * FROM consensus_rounds WHERE case_id = ? ORDER BY created_at, rowid")
      .all(caseId) as {
      id: string;
      case_id: string;
      layer_id: number;
      check_resolutions_json: string;
      created_at: number;
      resolved_at: number | null;
    }[];
    return rows.map((row) => this.mapConsensusRoundRow(row));
  }

  // --- tasks ---

  insertTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, case_id, layer_id, consensus_round_id, status, model_family,
          execution_target, rubric_snapshot_json, checks_json, skipped_reason,
          started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.caseId,
        task.layerId,
        task.consensusRoundId ?? null,
        task.status,
        task.modelFamily ?? null,
        task.executionTarget ?? null,
        task.rubricSnapshot !== undefined ? JSON.stringify(task.rubricSnapshot) : null,
        JSON.stringify(task.checks),
        task.skippedReason ?? null,
        task.startedAt,
        task.endedAt ?? null,
      );
  }

  updateTaskStatus(id: string, status: TaskStatus, endedAt?: number): void {
    this.db
      .prepare("UPDATE tasks SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, endedAt ?? null, id);
  }

  /** Final write for a Task's outcome — status plus every field only known once execution actually finished. */
  recordTaskResult(
    id: string,
    result: {
      status: TaskStatus;
      checks: CheckResult[];
      modelFamily?: string;
      executionTarget?: string;
      rubricSnapshot?: RubricSnapshot;
      skippedReason?: string;
      endedAt: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE tasks SET
          status = ?, checks_json = ?, model_family = ?, execution_target = ?,
          rubric_snapshot_json = ?, skipped_reason = ?, ended_at = ?
        WHERE id = ?`,
      )
      .run(
        result.status,
        JSON.stringify(result.checks),
        result.modelFamily ?? null,
        result.executionTarget ?? null,
        result.rubricSnapshot !== undefined ? JSON.stringify(result.rubricSnapshot) : null,
        result.skippedReason ?? null,
        result.endedAt,
        id,
      );
  }

  private mapTaskRow(row: {
    id: string;
    case_id: string;
    layer_id: number;
    consensus_round_id: string | null;
    status: TaskStatus;
    model_family: string | null;
    execution_target: string | null;
    rubric_snapshot_json: string | null;
    checks_json: string;
    skipped_reason: string | null;
    started_at: number;
    ended_at: number | null;
  }): Task {
    return {
      id: row.id,
      caseId: row.case_id,
      layerId: row.layer_id as LayerId,
      ...(row.consensus_round_id !== null && { consensusRoundId: row.consensus_round_id }),
      status: row.status,
      ...(row.model_family !== null && { modelFamily: row.model_family }),
      ...(row.execution_target !== null && { executionTarget: row.execution_target }),
      ...(row.rubric_snapshot_json !== null && {
        rubricSnapshot: JSON.parse(row.rubric_snapshot_json) as RubricSnapshot,
      }),
      checks: JSON.parse(row.checks_json) as CheckResult[],
      ...(row.skipped_reason !== null && { skippedReason: row.skipped_reason }),
      startedAt: row.started_at,
      ...(row.ended_at !== null && { endedAt: row.ended_at }),
    };
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          id: string;
          case_id: string;
          layer_id: number;
          consensus_round_id: string | null;
          status: TaskStatus;
          model_family: string | null;
          execution_target: string | null;
          rubric_snapshot_json: string | null;
          checks_json: string;
          skipped_reason: string | null;
          started_at: number;
          ended_at: number | null;
        }
      | undefined;
    return row ? this.mapTaskRow(row) : undefined;
  }

  getTasksByCase(caseId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE case_id = ? ORDER BY started_at, rowid")
      .all(caseId) as {
      id: string;
      case_id: string;
      layer_id: number;
      consensus_round_id: string | null;
      status: TaskStatus;
      model_family: string | null;
      execution_target: string | null;
      rubric_snapshot_json: string | null;
      checks_json: string;
      skipped_reason: string | null;
      started_at: number;
      ended_at: number | null;
    }[];
    return rows.map((row) => this.mapTaskRow(row));
  }

  getTasksByConsensusRound(consensusRoundId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE consensus_round_id = ? ORDER BY started_at, rowid")
      .all(consensusRoundId) as {
      id: string;
      case_id: string;
      layer_id: number;
      consensus_round_id: string | null;
      status: TaskStatus;
      model_family: string | null;
      execution_target: string | null;
      rubric_snapshot_json: string | null;
      checks_json: string;
      skipped_reason: string | null;
      started_at: number;
      ended_at: number | null;
    }[];
    return rows.map((row) => this.mapTaskRow(row));
  }
}
