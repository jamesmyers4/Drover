/**
 * Soak mode's SQLite layer — `soak.sqlite`, fully separate from Drover's
 * primary db and from Grader's `grader.sqlite` (own file, own schema, no FK
 * to `runs`/`sessions`/`action_events` or `grading_runs`/`cases`/`tasks`).
 * Built on the same generic `SqliteStore` runner `DroverDb`/`GraderDb` use
 * (`src/db/sqlite-store.ts`), parameterized over Soak's own migration set
 * (`src/soak/migrations.ts`) — per ADR 0007's "reuse shared low-level infra
 * opportunistically" precedent.
 */

import { randomUUID } from "node:crypto";
import { SqliteStore } from "../db/sqlite-store.js";
import type { FindingSeverity } from "../types/index.js";
import { soakMigrations } from "./migrations.js";
import type {
  CrossTurnFindingRecord,
  CrossTurnFindingType,
  MetricRecord,
  SoakBlueprintConfigSnapshot,
  SoakRun,
  SoakRunStatus,
  SoakTurnLane,
  TurnRecord,
} from "./types.js";

export function newSoakId(): string {
  return randomUUID();
}

export class SoakDb extends SqliteStore {
  /** @param path SQLite file path, or ":memory:" for tests. */
  constructor(path: string) {
    super(path, soakMigrations);
  }

  // --- soak runs ---

  insertSoakRun(run: SoakRun): void {
    this.db
      .prepare(
        `INSERT INTO soak_runs (
          id, app_name, blueprint_version, driver_model, target_base_url,
          blueprint_config_json, status, budget_ceiling_usd, spent_usd,
          started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.appName,
        run.blueprintVersion,
        run.driverModel,
        run.targetBaseUrl,
        JSON.stringify(run.blueprintConfig),
        run.status,
        run.budgetCeilingUsd,
        run.spentUsd,
        run.startedAt,
        run.endedAt ?? null,
      );
  }

  updateSoakRunStatus(id: string, status: SoakRunStatus, endedAt?: number): void {
    this.db
      .prepare("UPDATE soak_runs SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, endedAt ?? null, id);
  }

  /** Overwrites the running/final spend total — the caller (Session 3's budget tracker) owns the running sum, this just persists its current value. */
  updateSoakRunSpend(id: string, spentUsd: number): void {
    this.db.prepare("UPDATE soak_runs SET spent_usd = ? WHERE id = ?").run(spentUsd, id);
  }

  /** Overwrites the linked Grader `GradingRun.id` (`grader.sqlite`) — the most recent `drover soak analyze` invocation's Grader pass, not an accumulated history (CTS.md Session 7). */
  updateSoakRunGradingRunId(id: string, gradingRunId: string): void {
    this.db.prepare("UPDATE soak_runs SET grading_run_id = ? WHERE id = ?").run(gradingRunId, id);
  }

  /** Adds to the cumulative cross-turn-pass spend — a run can be re-analyzed via multiple `drover soak analyze` invocations, each billing real additional cost (mirrors `DroverDb.updateRunAnalystCost`'s COALESCE-add precedent). */
  updateSoakRunCrossTurnCost(id: string, costUsd: number): void {
    this.db
      .prepare(
        "UPDATE soak_runs SET cross_turn_cost_usd = COALESCE(cross_turn_cost_usd, 0) + ? WHERE id = ?",
      )
      .run(costUsd, id);
  }

  private mapSoakRunRow(row: {
    id: string;
    app_name: string;
    blueprint_version: string;
    driver_model: string;
    target_base_url: string;
    blueprint_config_json: string;
    status: SoakRunStatus;
    budget_ceiling_usd: number;
    spent_usd: number;
    started_at: number;
    ended_at: number | null;
    grading_run_id: string | null;
    cross_turn_cost_usd: number | null;
  }): SoakRun {
    return {
      id: row.id,
      appName: row.app_name,
      blueprintVersion: row.blueprint_version,
      driverModel: row.driver_model,
      targetBaseUrl: row.target_base_url,
      blueprintConfig: JSON.parse(row.blueprint_config_json) as SoakBlueprintConfigSnapshot,
      status: row.status,
      budgetCeilingUsd: row.budget_ceiling_usd,
      spentUsd: row.spent_usd,
      startedAt: row.started_at,
      ...(row.ended_at !== null && { endedAt: row.ended_at }),
      ...(row.grading_run_id !== null && { gradingRunId: row.grading_run_id }),
      ...(row.cross_turn_cost_usd !== null && { crossTurnCostUsd: row.cross_turn_cost_usd }),
    };
  }

  getSoakRun(id: string): SoakRun | undefined {
    const row = this.db.prepare("SELECT * FROM soak_runs WHERE id = ?").get(id) as
      | {
          id: string;
          app_name: string;
          blueprint_version: string;
          driver_model: string;
          target_base_url: string;
          blueprint_config_json: string;
          status: SoakRunStatus;
          budget_ceiling_usd: number;
          spent_usd: number;
          started_at: number;
          ended_at: number | null;
          grading_run_id: string | null;
          cross_turn_cost_usd: number | null;
        }
      | undefined;
    return row ? this.mapSoakRunRow(row) : undefined;
  }

  // --- turns ---

  insertTurn(turn: TurnRecord): void {
    this.db
      .prepare(
        `INSERT INTO turns (
          id, run_id, sequence, lane, variation_id, request_payload_json,
          response_payload_json, response_time_ms, http_status,
          explicit_error, error_detail, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.id,
        turn.runId,
        turn.sequence,
        turn.lane,
        turn.variationId,
        JSON.stringify(turn.requestPayload),
        turn.responsePayload !== undefined ? JSON.stringify(turn.responsePayload) : null,
        turn.responseTimeMs ?? null,
        turn.httpStatus ?? null,
        turn.explicitError ? 1 : 0,
        turn.errorDetail ?? null,
        turn.timestamp,
      );
  }

  private mapTurnRow(row: {
    id: string;
    run_id: string;
    sequence: number;
    lane: SoakTurnLane;
    variation_id: string;
    request_payload_json: string;
    response_payload_json: string | null;
    response_time_ms: number | null;
    http_status: number | null;
    explicit_error: number;
    error_detail: string | null;
    timestamp: number;
  }): TurnRecord {
    return {
      id: row.id,
      runId: row.run_id,
      sequence: row.sequence,
      lane: row.lane,
      variationId: row.variation_id,
      requestPayload: JSON.parse(row.request_payload_json) as unknown,
      ...(row.response_payload_json !== null && {
        responsePayload: JSON.parse(row.response_payload_json) as unknown,
      }),
      ...(row.response_time_ms !== null && { responseTimeMs: row.response_time_ms }),
      ...(row.http_status !== null && { httpStatus: row.http_status }),
      explicitError: row.explicit_error === 1,
      ...(row.error_detail !== null && { errorDetail: row.error_detail }),
      timestamp: row.timestamp,
    };
  }

  getTurn(id: string): TurnRecord | undefined {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as
      | {
          id: string;
          run_id: string;
          sequence: number;
          lane: SoakTurnLane;
          variation_id: string;
          request_payload_json: string;
          response_payload_json: string | null;
          response_time_ms: number | null;
          http_status: number | null;
          explicit_error: number;
          error_detail: string | null;
          timestamp: number;
        }
      | undefined;
    return row ? this.mapTurnRow(row) : undefined;
  }

  getTurnsByRun(runId: string): TurnRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM turns WHERE run_id = ? ORDER BY sequence, rowid")
      .all(runId) as {
      id: string;
      run_id: string;
      sequence: number;
      lane: SoakTurnLane;
      variation_id: string;
      request_payload_json: string;
      response_payload_json: string | null;
      response_time_ms: number | null;
      http_status: number | null;
      explicit_error: number;
      error_detail: string | null;
      timestamp: number;
    }[];
    return rows.map((row) => this.mapTurnRow(row));
  }

  // --- metrics ---

  insertMetric(metric: MetricRecord): void {
    this.db
      .prepare("INSERT INTO metrics (id, run_id, name, value, recorded_at) VALUES (?, ?, ?, ?, ?)")
      .run(metric.id, metric.runId, metric.name, metric.value, metric.recordedAt);
  }

  private mapMetricRow(row: {
    id: string;
    run_id: string;
    name: string;
    value: number;
    recorded_at: number;
  }): MetricRecord {
    return {
      id: row.id,
      runId: row.run_id,
      name: row.name,
      value: row.value,
      recordedAt: row.recorded_at,
    };
  }

  getMetricsByRun(runId: string, name?: string): MetricRecord[] {
    const rows = name
      ? (this.db
          .prepare(
            "SELECT * FROM metrics WHERE run_id = ? AND name = ? ORDER BY recorded_at, rowid",
          )
          .all(runId, name) as {
          id: string;
          run_id: string;
          name: string;
          value: number;
          recorded_at: number;
        }[])
      : (this.db
          .prepare("SELECT * FROM metrics WHERE run_id = ? ORDER BY recorded_at, rowid")
          .all(runId) as {
          id: string;
          run_id: string;
          name: string;
          value: number;
          recorded_at: number;
        }[]);
    return rows.map((row) => this.mapMetricRow(row));
  }

  // --- cross-turn findings ---

  insertCrossTurnFinding(finding: CrossTurnFindingRecord): void {
    this.db
      .prepare(
        `INSERT INTO cross_turn_findings (
          id, run_id, type, severity, description, turn_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        finding.id,
        finding.runId,
        finding.type,
        finding.severity,
        finding.description,
        JSON.stringify(finding.turnIds),
        finding.createdAt,
      );
  }

  private mapCrossTurnFindingRow(row: {
    id: string;
    run_id: string;
    type: CrossTurnFindingType;
    severity: FindingSeverity;
    description: string;
    turn_ids_json: string;
    created_at: number;
  }): CrossTurnFindingRecord {
    return {
      id: row.id,
      runId: row.run_id,
      type: row.type,
      severity: row.severity,
      description: row.description,
      turnIds: JSON.parse(row.turn_ids_json) as string[],
      createdAt: row.created_at,
    };
  }

  getCrossTurnFindingsByRun(runId: string): CrossTurnFindingRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM cross_turn_findings WHERE run_id = ? ORDER BY created_at, rowid")
      .all(runId) as {
      id: string;
      run_id: string;
      type: CrossTurnFindingType;
      severity: FindingSeverity;
      description: string;
      turn_ids_json: string;
      created_at: number;
    }[];
    return rows.map((row) => this.mapCrossTurnFindingRow(row));
  }
}
