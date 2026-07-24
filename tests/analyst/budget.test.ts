import { describe, expect, it } from "vitest";
import { UnknownModelPricingError } from "../../src/actor/budget.js";
import {
  AnalystBudgetExceededError,
  estimateAnalystCostUsd,
  estimateTokens,
} from "../../src/analyst/budget.js";

describe("estimateTokens", () => {
  it("estimates roughly 4 chars per token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("estimateAnalystCostUsd", () => {
  it("grows with prompt length and output ceiling", () => {
    const small = estimateAnalystCostUsd("claude-sonnet-5", "sys", "user", 100);
    const large = estimateAnalystCostUsd("claude-sonnet-5", "sys".repeat(1000), "user", 4096);
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });

  it("applies the 50% Batch discount on top of list pricing", () => {
    const withDiscount = estimateAnalystCostUsd("claude-sonnet-5", "x".repeat(4000), "", 0);
    // list price for ~1000 input tokens at $3/M is $0.003; discounted should be half that.
    expect(withDiscount).toBeCloseTo(0.0015, 5);
  });

  it("throws for a model with no pricing entry", () => {
    expect(() => estimateAnalystCostUsd("unknown-model", "sys", "user", 100)).toThrow(
      UnknownModelPricingError,
    );
  });
});

describe("AnalystBudgetExceededError", () => {
  it("carries the estimated cost and ceiling, and reports them in the message", () => {
    const err = new AnalystBudgetExceededError(1.23, 0.5);
    expect(err.estimatedCostUsd).toBe(1.23);
    expect(err.ceilingUsd).toBe(0.5);
    expect(err.message).toContain("1.2300");
    expect(err.message).toContain("0.5000");
  });
});
