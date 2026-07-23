/**
 * Run and session records — the top-level rows every event and finding hangs
 * off. Raw timestamps only; no derived-metric columns.
 */

import type { SimConfig } from "./config.js";

export type RunStatus = "running" | "completed" | "budget-stopped" | "crashed";

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
