/**
 * App-specific domain pack layer — one local config file per target app.
 * Shapes are defined verbatim in CONTEXT.md ("Persona & domain pack schema").
 */

import type { PersonaArchetype, WeightedGoal } from "./persona.js";

export interface Goal {
  id: string;
  description: string;
  actionBudget: number;
  checkpoints: Checkpoint[];
  successCheckpointId: string;
}

export interface Checkpoint {
  id: string;
  description: string;
  /**
   * Detector DSL string evaluated after each action. Format is finalized in
   * Session 3 (planned: `url:`, `selector:`, `text:` matchers).
   */
  detector: string;
}

/**
 * Passed to a DomainPack's teardown hook (Session 4). `runStartedAt`/
 * `runEndedAt` (added per GAPS.md's S4 entry) exist specifically so a pack
 * author can implement the "sweep by timestamp window" correlation strategy
 * without needing separate SQLite access — Drover doesn't track which
 * app-side rows a run actually created, but it does always know when the
 * run started and (as of the moment teardown is invoked) ended, so at least
 * one of the two documented strategies is fully supported out of the box.
 * The other strategy (tagging synthetic data with `runId` at fill-time)
 * needs nothing further from Drover — it's already just `runId` plus
 * whatever the pack itself writes into the app during a session.
 */
export interface DomainPackTeardownContext {
  runId: string;
  targetBaseUrl: string;
  /** Raw epoch milliseconds — this run's own Run.startedAt. */
  runStartedAt: number;
  /** Raw epoch milliseconds, taken right as the run finishes and teardown is invoked. */
  runEndedAt: number;
}

export interface DomainPack {
  appName: string;
  personas: PersonaArchetype[];
  goals: Goal[];
  goalWeightsByPersona: Record<string, WeightedGoal[]>;
  /**
   * Enforced, not advisory: `restricted` packs must refuse to run when a
   * non-approved provider is configured for the actor tier (checked at
   * config-load time).
   */
  dataPolicy: "synthetic-only" | "restricted";
  /**
   * Optional config-declared cleanup hook that wipes run-created staging
   * data (CONTEXT.md "Environment & safety": "staging teardown wipes
   * everything a run created before the next one starts"). Not in
   * CONTEXT.md's verbatim schema — added in Session 4, see SESSION-LOG.md.
   * Runs finally-style: after a completed, budget-stopped, *or* crashed run.
   */
  teardown?: (ctx: DomainPackTeardownContext) => Promise<void>;
}
