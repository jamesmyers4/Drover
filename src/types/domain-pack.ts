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
}
