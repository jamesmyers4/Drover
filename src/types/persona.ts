/**
 * Generic persona/archetype layer — ships with Drover, applies to any target app.
 * Shapes are defined verbatim in CONTEXT.md ("Persona & domain pack schema").
 */

export interface PersonaArchetype {
  id: string;
  name: string;
  traits: {
    patience: number;
    techSavviness: number;
    deviceType: "mobile" | "desktop" | "tablet";
    familiarity: "new" | "returning" | "veteran";
  };
}

export interface WeightedGoal {
  goalId: string;
  weight: number;
}
