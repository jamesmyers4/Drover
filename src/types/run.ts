/**
 * Run and session records — the top-level rows every event and finding hangs
 * off. Raw timestamps only; no derived-metric columns.
 */

import type { SimConfig } from "./config.js";

export type RunStatus = "running" | "completed" | "budget-stopped" | "crashed";

/** A checkpoint id's originating context, snapshotted from the domain pack at run-creation time. */
export interface CheckpointContextEntry {
  /** The Goal.id this checkpoint belongs to. */
  goalId: string;
  description: string;
}

export interface Run {
  id: string;
  /** DomainPack.appName of the pack this run executed. */
  appName: string;
  /** Snapshot of the resolved SimConfig the run started with. */
  config: SimConfig;
  status: RunStatus;
  /** Raw epoch milliseconds. */
  startedAt: number;
  endedAt?: number;
  /**
   * Checkpoint id -> {goalId, description}, snapshotted from
   * `DomainPack.goals[].checkpoints` at run-creation time (GAPS.md: the
   * analyst tier previously only ever saw a checkpoint's opaque id string,
   * with no description or goal context to reason about). Optional so runs
   * recorded before this field existed still round-trip through the DB
   * layer unchanged.
   */
  checkpointContext?: Record<string, CheckpointContextEntry>;
  /**
   * Actual actor-tier spend for this run, recorded once the run finishes
   * (Session 6 — reporting needs a real "cost actuals vs. budget" number,
   * and the in-memory `RunDiscoveryResult.totalCostUsd` a `drover run`
   * invocation returns doesn't survive to a later, separate `drover report`
   * process). Absent until the run ends.
   */
  actorCostUsd?: number;
  /**
   * Cumulative analyst-tier spend across every `drover analyze` invocation
   * for this run (a run can be re-analyzed, and each pass is real
   * additional spend). Absent until the first `drover analyze` completes.
   */
  analystCostUsd?: number;
}

export type SessionStatus = "running" | "completed" | "hard-stopped" | "budget-capped";

export interface PersonaSession {
  id: string;
  runId: string;
  personaId: string;
  /** The goal drawn from the weighted pool for this session. */
  goalId: string;
  status: SessionStatus;
  /** Raw epoch milliseconds. */
  startedAt: number;
  endedAt?: number;
}
