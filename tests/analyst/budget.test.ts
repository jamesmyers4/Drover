import { describe, expect, it, vi } from "vitest";
import { UnknownModelPricingError } from "../../src/actor/budget.js";
import type { TokenCounter } from "../../src/analyst/budget.js";

// The real SDK's `messages` is an instance property set in the constructor,
// not a prototype getter, so it can't be spied on after construction — mock
// the whole module instead, same pattern tests/actor/provider.test.ts and
// tests/analyst/provider.test.ts already established. This lets
// createApiTokenCounter's real success path (CLAUDE.md/GAPS.md: "never
// exercised against a live API") be proven without real credentials — a
// mocked countTokens response is enough to verify the arithmetic.
const { mockCountTokens } = vi.hoisted(() => ({ mockCountTokens: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function MockAnthropic(this: { messages: unknown }) {
    this.messages = { countTokens: mockCountTokens };
  }),
}));

const {
  AnalystBudgetExceededError,
  createApiTokenCounter,
  estimateAnalystCostUsd,
  estimateTokens,
} = await import("../../src/analyst/budget.js");

describe("estimateTokens", () => {
  it("estimates roughly 4 chars per token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

// No ANTHROPIC_API_KEY is available in this environment (see SESSION-LOG.md's
// "Outstanding pending user input"), so every call below either injects a fake
// TokenCounter or relies on the real one's construction/call rejecting and
// estimateAnalystCostUsd falling back to the chars/4 heuristic — the same
// heuristic math the pre-tokenizer version of these tests asserted on.
describe("estimateAnalystCostUsd", () => {
  it("grows with prompt length and output ceiling (heuristic fallback, no credentials)", async () => {
    const small = await estimateAnalystCostUsd("claude-sonnet-5", "sys", "user", 100);
    const large = await estimateAnalystCostUsd("claude-sonnet-5", "sys".repeat(1000), "user", 4096);
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });

  it("applies the 50% Batch discount on top of list pricing (heuristic fallback)", async () => {
    const withDiscount = await estimateAnalystCostUsd("claude-sonnet-5", "x".repeat(4000), "", 0);
    // list price for ~1000 input tokens at $3/M is $0.003; discounted should be half that.
    expect(withDiscount).toBeCloseTo(0.0015, 5);
  });

  it("throws for a model with no pricing entry", async () => {
    await expect(estimateAnalystCostUsd("unknown-model", "sys", "user", 100)).rejects.toThrow(
      UnknownModelPricingError,
    );
  });

  it("uses an injected TokenCounter's exact count instead of the chars/4 heuristic", async () => {
    const exactCounter: TokenCounter = async () => 1_000_000;
    const costUsd = await estimateAnalystCostUsd("claude-sonnet-5", "sys", "user", 0, exactCounter);
    // 1,000,000 input tokens at $3/M list price, batch-discounted 50%.
    expect(costUsd).toBeCloseTo(1.5, 5);
  });

  it("falls back to the chars/4 heuristic when the injected TokenCounter rejects", async () => {
    const failingCounter: TokenCounter = async () => {
      throw new Error("no credentials");
    };
    const withFallback = await estimateAnalystCostUsd(
      "claude-sonnet-5",
      "x".repeat(4000),
      "",
      0,
      failingCounter,
    );
    // Same heuristic-math assertion as the no-tokenizer discount test above.
    expect(withFallback).toBeCloseTo(0.0015, 5);
  });
});

describe("createApiTokenCounter (mocked SDK — the real countTokens success path)", () => {
  it("returns the API's input_tokens count, requesting the exact system+messages shape the real Batch request sends", async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 1234 });
    const counter = createApiTokenCounter("claude-sonnet-5");

    const count = await counter("system prompt text", "user prompt text");

    expect(count).toBe(1234);
    expect(mockCountTokens).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      system: "system prompt text",
      messages: [{ role: "user", content: "user prompt text" }],
    });
  });

  it("estimateAnalystCostUsd uses this real path by default (no countTokens override) and reflects its exact count", async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 1_000_000 });

    const costUsd = await estimateAnalystCostUsd("claude-sonnet-5", "sys", "user", 0);

    // 1,000,000 input tokens at $3/M list price, batch-discounted 50% — same
    // arithmetic the injected-TokenCounter test above already proves, but
    // driven through the real default path this time.
    expect(costUsd).toBeCloseTo(1.5, 5);
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
