/**
 * Core persona archetype set — ships with Drover itself, reusable across any
 * target app's domain pack (CONTEXT.md "Persona & domain pack schema": "A
 * small core archetype set ships with the tool itself... the actual
 * open-source value — someone adopting Drover for a different app reuses
 * these archetypes and only has to write their own domain pack").
 *
 * `patience`/`techSavviness` are 0..1 normalized (README.md's "Writing a
 * domain pack" section) — not spelled out in the bare `number` type itself.
 */

import type { PersonaArchetype } from "../src/types/index.js";

/** In a hurry, low tolerance for friction, wants the fastest path to done. */
export const impatientRushed: PersonaArchetype = {
  id: "impatient-rushed",
  name: "Impatient, Rushed",
  traits: {
    patience: 0.15,
    techSavviness: 0.6,
    deviceType: "desktop",
    familiarity: "returning",
  },
};

/** Never used the app before, reads everything before clicking, double-checks. */
export const firstTimerCautious: PersonaArchetype = {
  id: "first-timer-cautious",
  name: "First-Timer, Cautious",
  traits: {
    patience: 0.8,
    techSavviness: 0.3,
    deviceType: "desktop",
    familiarity: "new",
  },
};

/** Half-attention, easily sidetracked by unrelated links, prone to wandering off-goal. */
export const distracted: PersonaArchetype = {
  id: "distracted",
  name: "Distracted",
  traits: {
    patience: 0.5,
    techSavviness: 0.5,
    deviceType: "mobile",
    familiarity: "returning",
  },
};

/** Knows the app well, drives it efficiently on a small mobile screen. */
export const powerUserMobile: PersonaArchetype = {
  id: "power-user-mobile",
  name: "Power User on Mobile",
  traits: {
    patience: 0.9,
    techSavviness: 0.95,
    deviceType: "mobile",
    familiarity: "veteran",
  },
};

/** All four core archetypes, in the order CONTEXT.md lists them. */
export const CORE_ARCHETYPES: PersonaArchetype[] = [
  impatientRushed,
  firstTimerCautious,
  distracted,
  powerUserMobile,
];
