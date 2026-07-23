import { describe, expect, it } from "vitest";
import {
  buildSchedule,
  drawWeightedGoal,
  EmptyDomainPackError,
  MissingGoalWeightsError,
} from "../../src/orchestrator/schedule.js";
import type { PersonaArchetype, WeightedGoal } from "../../src/types/index.js";

function persona(id: string): PersonaArchetype {
  return {
    id,
    name: id,
    traits: { patience: 0.5, techSavviness: 0.5, deviceType: "desktop", familiarity: "new" },
  };
}

describe("drawWeightedGoal", () => {
  const weights: WeightedGoal[] = [
    { goalId: "a", weight: 1 },
    { goalId: "b", weight: 3 },
  ];

  it("picks the first goal when the draw lands in its slice", () => {
    expect(drawWeightedGoal(weights, () => 0)).toBe("a");
  });

  it("picks a later goal once the draw exceeds earlier slices", () => {
    expect(drawWeightedGoal(weights, () => 0.5)).toBe("b");
  });

  it("falls back to the last goal on a boundary rounding case", () => {
    expect(drawWeightedGoal(weights, () => 0.999999999)).toBe("b");
  });

  it("throws on an empty or zero-weight pool", () => {
    expect(() => drawWeightedGoal([], () => 0)).toThrow();
    expect(() => drawWeightedGoal([{ goalId: "a", weight: 0 }], () => 0)).toThrow();
  });
});

describe("buildSchedule", () => {
  it("expands org size x weeks x sessions/week into the right total count", () => {
    const domainPack = {
      personas: [persona("p1"), persona("p2")],
      goalWeightsByPersona: {
        p1: [{ goalId: "g1", weight: 1 }],
        p2: [{ goalId: "g2", weight: 1 }],
      },
    };
    const schedule = buildSchedule(
      domainPack,
      { orgSize: 4, simulatedWeeks: 2, sessionsPerPersonaPerWeek: 1 },
      () => 0,
    );
    expect(schedule).toHaveLength(4 * 2 * 1);
  });

  it("round-robin assigns org members to archetypes and keeps instance numbers stable across weeks", () => {
    const domainPack = {
      personas: [persona("p1"), persona("p2")],
      goalWeightsByPersona: {
        p1: [{ goalId: "g1", weight: 1 }],
        p2: [{ goalId: "g2", weight: 1 }],
      },
    };
    const schedule = buildSchedule(
      domainPack,
      { orgSize: 4, simulatedWeeks: 2, sessionsPerPersonaPerWeek: 1 },
      () => 0,
    );
    // Week 1: members 0..3 -> p1#1, p2#1, p1#2, p2#2
    expect(schedule.slice(0, 4).map((s) => s.personaInstanceId)).toEqual([
      "p1#1",
      "p2#1",
      "p1#2",
      "p2#2",
    ]);
    // Week 2 repeats the same instance ids (same simulated org, later in time).
    expect(schedule.slice(4, 8).map((s) => s.personaInstanceId)).toEqual([
      "p1#1",
      "p2#1",
      "p1#2",
      "p2#2",
    ]);
    expect(schedule.slice(4, 8).map((s) => s.simulatedWeek)).toEqual([2, 2, 2, 2]);
  });

  it("is week-major: every week-1 session precedes every week-2 session", () => {
    const domainPack = {
      personas: [persona("p1")],
      goalWeightsByPersona: { p1: [{ goalId: "g1", weight: 1 }] },
    };
    const schedule = buildSchedule(
      domainPack,
      { orgSize: 2, simulatedWeeks: 2, sessionsPerPersonaPerWeek: 1 },
      () => 0,
    );
    const weeks = schedule.map((s) => s.simulatedWeek);
    expect(weeks).toEqual([1, 1, 2, 2]);
  });

  it("throws EmptyDomainPackError when the pack has no personas", () => {
    expect(() =>
      buildSchedule(
        { personas: [], goalWeightsByPersona: {} },
        { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
      ),
    ).toThrow(EmptyDomainPackError);
  });

  it("throws MissingGoalWeightsError when a persona has no weighted goal pool", () => {
    expect(() =>
      buildSchedule(
        { personas: [persona("p1")], goalWeightsByPersona: {} },
        { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
      ),
    ).toThrow(MissingGoalWeightsError);
  });
});
