import { describe, expect, it } from "vitest";
import { computeCostUsd, SessionBudget, UnknownModelPricingError } from "../../src/actor/budget.js";

describe("computeCostUsd", () => {
  it("prices input/output/cache tokens for a known model", () => {
    const cost = computeCostUsd("claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    // 1.0 (input) + 5.0 (output) + 1.25 (cache write @ 1.25x) + 0.1 (cache read @ 0.1x)
    expect(cost).toBeCloseTo(1.0 + 5.0 + 1.25 + 0.1, 6);
  });

  it("throws for an unpriced model rather than silently costing $0", () => {
    expect(() =>
      computeCostUsd("some-future-model", {
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toThrow(UnknownModelPricingError);
  });
});

describe("SessionBudget", () => {
  it("is not exceeded until spend reaches the soft cap", () => {
    const budget = new SessionBudget(0.01);
    expect(budget.exceeded).toBe(false);
    budget.record(0.005);
    expect(budget.exceeded).toBe(false);
    budget.record(0.005);
    expect(budget.exceeded).toBe(true);
    expect(budget.spent).toBeCloseTo(0.01, 9);
  });
});
