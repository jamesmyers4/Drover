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

/** Passed to a DomainPack's teardown hook (Session 4). */
export interface DomainPackTeardownContext {
  runId: string;
  targetBaseUrl: string;
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
   * CONTEXT.md's verbatim schema — added in Session 4, see BUILD-STATE.md.
   * Runs finally-style: after a completed, budget-stopped, *or* crashed run.
   */
  teardown?: (ctx: DomainPackTeardownContext) => Promise<void>;
}
