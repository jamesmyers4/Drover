import { describe, expect, it } from "vitest";
import { GraderBudget, GraderBudgetExceededError } from "../../src/grader/budget.js";

describe("GraderBudget", () => {
  it("never throws when ceilingUsd is unset (uncapped)", () => {
    const budget = new GraderBudget();
    budget.record(1_000_000);
    expect(() => budget.assertCanDispatch()).not.toThrow();
  });

  it("allows dispatch while spend is strictly below the ceiling", () => {
    const budget = new GraderBudget(1.0);
    budget.record(0.5);
    expect(() => budget.assertCanDispatch()).not.toThrow();
    expect(budget.spent).toBe(0.5);
  });

  it("throws GraderBudgetExceededError once spend has reached the ceiling", () => {
    const budget = new GraderBudget(1.0);
    budget.record(1.0);
    expect(() => budget.assertCanDispatch()).toThrow(GraderBudgetExceededError);
  });

  it("throws once spend has exceeded the ceiling", () => {
    const budget = new GraderBudget(1.0);
    budget.record(0.6);
    budget.record(0.6);
    expect(budget.spent).toBeCloseTo(1.2);
    expect(() => budget.assertCanDispatch()).toThrow(GraderBudgetExceededError);
  });

  it("still allows the call that pushes spend over the ceiling to complete — the check happens before dispatch, not mid-call", () => {
    const budget = new GraderBudget(1.0);
    expect(() => budget.assertCanDispatch()).not.toThrow();
    budget.record(5.0);
    expect(() => budget.assertCanDispatch()).toThrow(GraderBudgetExceededError);
  });
});
