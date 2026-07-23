/**
 * Expands a domain pack + run dimensions into a sequential schedule of
 * persona-sessions (CONTEXT.md "Execution modes": discovery mode = "org size
 * x simulated duration in weeks x session frequency"; CLAUDE.md Session 4).
 *
 * `orgSize` simulated org members are round-robin assigned one archetype
 * each from `domainPack.personas` (not one-to-one — a pack usually ships far
 * fewer archetypes than a simulated org has people). Iteration order is
 * week-major (all of week 1's sessions, across every org member, before
 * week 2's) rather than persona-major — CONTEXT.md doesn't specify an order,
 * only that execution is sequential; week-major better reflects "simulated
 * organizational time" than batching one persona's whole tenure first. See
 * BUILD-STATE.md's decisions log.
 */

import type { DomainPack, RunDimensions, WeightedGoal } from "../types/index.js";

export interface ScheduledSession {
  /** e.g. "impatient-rushed#3" — the Nth simulated org member assigned this archetype. */
  personaInstanceId: string;
  archetypeId: string;
  /** 1-indexed simulated week. */
  simulatedWeek: number;
  /** 1-indexed session number within that persona's week. */
  sessionIndexInWeek: number;
  /** Drawn from goalWeightsByPersona[archetypeId]. */
  goalId: string;
}

export class EmptyDomainPackError extends Error {
  constructor() {
    super("Domain pack has no personas to schedule.");
    this.name = "EmptyDomainPackError";
  }
}

export class MissingGoalWeightsError extends Error {
  constructor(personaId: string) {
    super(`Domain pack has no goalWeightsByPersona entry for persona "${personaId}".`);
    this.name = "MissingGoalWeightsError";
  }
}

/** Weighted-random pick from a WeightedGoal pool. `rand` returns a value in [0, 1). */
export function drawWeightedGoal(weights: WeightedGoal[], rand: () => number): string {
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0 || weights.length === 0) {
    throw new Error("Weighted goal pool must contain at least one goal with positive weight.");
  }
  let r = rand() * total;
  for (const w of weights) {
    if (r < w.weight) return w.goalId;
    r -= w.weight;
  }
  // Floating-point rounding can push r to exactly `total` — fall back to the last entry.
  return (weights[weights.length - 1] as WeightedGoal).goalId;
}

export function buildSchedule(
  domainPack: Pick<DomainPack, "personas" | "goalWeightsByPersona">,
  dimensions: RunDimensions,
  rand: () => number = Math.random,
): ScheduledSession[] {
  if (domainPack.personas.length === 0) throw new EmptyDomainPackError();

  const instanceCounts = new Map<string, number>();
  const schedule: ScheduledSession[] = [];

  for (let week = 1; week <= dimensions.simulatedWeeks; week++) {
    for (let member = 0; member < dimensions.orgSize; member++) {
      const archetype = domainPack.personas[member % domainPack.personas.length];
      if (!archetype) throw new EmptyDomainPackError();
      const weights = domainPack.goalWeightsByPersona[archetype.id];
      if (!weights || weights.length === 0) throw new MissingGoalWeightsError(archetype.id);

      // Same org member reappears across weeks — keep its instance number stable.
      const instanceKey = `${archetype.id}#${member}`;
      const instanceNumber =
        instanceCounts.get(instanceKey) ?? Math.floor(member / domainPack.personas.length) + 1;
      instanceCounts.set(instanceKey, instanceNumber);

      for (let s = 1; s <= dimensions.sessionsPerPersonaPerWeek; s++) {
        schedule.push({
          personaInstanceId: `${archetype.id}#${instanceNumber}`,
          archetypeId: archetype.id,
          simulatedWeek: week,
          sessionIndexInWeek: s,
          goalId: drawWeightedGoal(weights, rand),
        });
      }
    }
  }

  return schedule;
}
