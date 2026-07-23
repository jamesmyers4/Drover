import { describe, expect, it } from "vitest";
import {
  AnthropicModelProvider,
  assertDataPolicyAllowed,
  createModelProvider,
  DataPolicyViolationError,
  DEFAULT_ACTOR_MODEL,
  ScriptedModelProvider,
} from "../../src/actor/provider.js";

describe("assertDataPolicyAllowed", () => {
  it("allows any provider for synthetic-only domain packs", () => {
    expect(() =>
      assertDataPolicyAllowed("synthetic-only", { provider: "some-cheap-provider", model: "x" }),
    ).not.toThrow();
  });

  it("allows anthropic for restricted domain packs", () => {
    expect(() =>
      assertDataPolicyAllowed("restricted", { provider: "anthropic", model: DEFAULT_ACTOR_MODEL }),
    ).not.toThrow();
  });

  it("refuses a non-approved provider for restricted domain packs", () => {
    expect(() =>
      assertDataPolicyAllowed("restricted", { provider: "some-cheap-provider", model: "x" }),
    ).toThrow(DataPolicyViolationError);
  });
});

describe("createModelProvider", () => {
  it("builds an AnthropicModelProvider for provider 'anthropic'", () => {
    const provider = createModelProvider({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(provider).toBeInstanceOf(AnthropicModelProvider);
    expect(provider.model).toBe("claude-haiku-4-5");
  });

  it("rejects an unsupported provider", () => {
    expect(() => createModelProvider({ provider: "not-a-real-provider", model: "x" })).toThrow(
      /Unsupported actor-tier provider/,
    );
  });
});

describe("ScriptedModelProvider", () => {
  it("replays decisions in order and reports a fixed cost per call", async () => {
    const provider = new ScriptedModelProvider(
      [
        { reasoning: "one", actionType: "navigate", url: "https://example.test" },
        { reasoning: "two", actionType: "finish", outcome: "success" },
      ],
      0.002,
    );

    const first = await provider.decide({ systemPrompt: "s", userPrompt: "u" });
    expect(first.decision.reasoning).toBe("one");
    expect(first.usage.costUsd).toBe(0.002);

    const second = await provider.decide({ systemPrompt: "s", userPrompt: "u" });
    expect(second.decision.reasoning).toBe("two");

    await expect(provider.decide({ systemPrompt: "s", userPrompt: "u" })).rejects.toThrow(
      /script exhausted/,
    );
  });
});
