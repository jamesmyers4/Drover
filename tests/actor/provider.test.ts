import { describe, expect, it, vi } from "vitest";

// The real SDK's `messages` is an instance property set in the constructor
// (`this.messages = new API.Messages(this)`), not a prototype getter, so it
// can't be spied on after construction — mock the whole module instead. This
// also means these tests never need real ANTHROPIC_API_KEY credentials.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  // A regular function, not an arrow function — arrow functions can't be
  // constructors, and `new Anthropic()` in provider.ts requires this to be
  // callable with `new`.
  default: vi.fn().mockImplementation(function MockAnthropic(this: { messages: unknown }) {
    this.messages = { create: mockCreate };
  }),
}));

const {
  AnthropicModelProvider,
  assertDataPolicyAllowed,
  createModelProvider,
  DataPolicyViolationError,
  DEFAULT_ACTOR_MODEL,
  MalformedDecisionError,
  MAX_REASONING_LENGTH,
  ScriptedModelProvider,
} = await import("../../src/actor/provider.js");

const BASE_USAGE = {
  input_tokens: 1000,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

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

describe("AnthropicModelProvider malformed decisions still report billed usage", () => {
  it("attaches billed usage to MalformedDecisionError when no tool_use block comes back", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "oops" }],
      usage: BASE_USAGE,
    });
    const provider = new AnthropicModelProvider(DEFAULT_ACTOR_MODEL);

    const err = await provider
      .decide({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedDecisionError);
    const malformed = err as InstanceType<typeof MalformedDecisionError>;
    expect(malformed.usage).toBeDefined();
    expect(malformed.usage?.inputTokens).toBe(1000);
    expect(malformed.usage?.outputTokens).toBe(20);
    expect(malformed.usage?.costUsd).toBeGreaterThan(0);
  });

  it("attaches billed usage to MalformedDecisionError when the tool input fails validation", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", name: "decide_action", input: { actionType: "navigate" } }],
      usage: BASE_USAGE,
    });
    const provider = new AnthropicModelProvider(DEFAULT_ACTOR_MODEL);

    const err = await provider
      .decide({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedDecisionError);
    const malformed = err as InstanceType<typeof MalformedDecisionError>;
    expect(malformed.message).toMatch(/missing or empty 'reasoning'/);
    expect(malformed.usage?.costUsd).toBeGreaterThan(0);
  });

  it("returns the same usage/cost shape as a well-formed decision on success", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "decide_action",
          input: { reasoning: "go home", actionType: "navigate", url: "https://example.test" },
        },
      ],
      usage: BASE_USAGE,
    });
    const provider = new AnthropicModelProvider(DEFAULT_ACTOR_MODEL);

    const result = await provider.decide({ systemPrompt: "s", userPrompt: "u" });

    expect(result.decision.actionType).toBe("navigate");
    expect(result.usage.costUsd).toBeGreaterThan(0);
  });
});

describe("reasoning length is capped by truncation, not rejection", () => {
  it("passes a short reasoning string through unchanged", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "decide_action",
          input: { reasoning: "go home", actionType: "navigate", url: "https://example.test" },
        },
      ],
      usage: BASE_USAGE,
    });
    const provider = new AnthropicModelProvider(DEFAULT_ACTOR_MODEL);

    const result = await provider.decide({ systemPrompt: "s", userPrompt: "u" });

    expect(result.decision.reasoning).toBe("go home");
  });

  it("truncates an over-long reasoning string instead of throwing MalformedDecisionError", async () => {
    const longReasoning = "a".repeat(MAX_REASONING_LENGTH + 50);
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "decide_action",
          input: { reasoning: longReasoning, actionType: "navigate", url: "https://example.test" },
        },
      ],
      usage: BASE_USAGE,
    });
    const provider = new AnthropicModelProvider(DEFAULT_ACTOR_MODEL);

    const result = await provider.decide({ systemPrompt: "s", userPrompt: "u" });

    expect(result.decision.reasoning.length).toBe(MAX_REASONING_LENGTH);
    expect(result.decision.reasoning.endsWith("…")).toBe(true);
    expect(result.decision.reasoning.startsWith("a".repeat(MAX_REASONING_LENGTH - 1))).toBe(true);
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
