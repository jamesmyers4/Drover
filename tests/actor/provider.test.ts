import { afterEach, describe, expect, it, vi } from "vitest";

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
  DEFAULT_OLLAMA_BASE_URL,
  MalformedDecisionError,
  MAX_REASONING_LENGTH,
  OllamaModelProvider,
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

  it("allows ollama for restricted domain packs (zero-exposure local model)", () => {
    expect(() =>
      assertDataPolicyAllowed("restricted", { provider: "ollama", model: "llama3.1" }),
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

  it("builds an OllamaModelProvider for provider 'ollama'", () => {
    const provider = createModelProvider({ provider: "ollama", model: "llama3.1" });
    expect(provider).toBeInstanceOf(OllamaModelProvider);
    expect(provider.model).toBe("llama3.1");
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

describe("AnthropicModelProvider — parseDecision validation surfaces as MalformedDecisionError", () => {
  it.each([
    [
      "an invalid actionType",
      { reasoning: "ok", actionType: "teleport" },
      /invalid actionType "teleport"/,
    ],
    [
      "a navigate decision missing url",
      { reasoning: "ok", actionType: "navigate" },
      /actionType 'navigate' requires 'url'/,
    ],
    [
      "a click decision missing selector",
      { reasoning: "ok", actionType: "click" },
      /actionType 'click' requires 'selector'/,
    ],
    [
      "a fill decision missing selector",
      { reasoning: "ok", actionType: "fill", value: "x" },
      /actionType 'fill' requires 'selector'/,
    ],
    [
      "a fill decision missing value",
      { reasoning: "ok", actionType: "fill", selector: "#x" },
      /actionType 'fill' requires 'value'/,
    ],
  ])("rejects %s", async (_label, input, messagePattern) => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", name: "decide_action", input }],
      usage: BASE_USAGE,
    });
    const provider = new AnthropicModelProvider(DEFAULT_ACTOR_MODEL);

    const err = await provider
      .decide({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedDecisionError);
    expect((err as Error).message).toMatch(messagePattern);
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

describe("OllamaModelProvider", () => {
  function mockFetchOnce(status: number, jsonBody: unknown) {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(jsonBody),
      text: () => Promise.resolve(JSON.stringify(jsonBody)),
    });
    vi.stubGlobal("fetch", mockFetch);
    return mockFetch;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to the local Ollama server and posts to /api/chat", async () => {
    const mockFetch = mockFetchOnce(200, {
      message: {
        tool_calls: [
          {
            function: {
              name: "decide_action",
              arguments: { reasoning: "go", actionType: "finish", outcome: "success" },
            },
          },
        ],
      },
      prompt_eval_count: 50,
      eval_count: 5,
    });
    const provider = new OllamaModelProvider("llama3.1");

    await provider.decide({ systemPrompt: "s", userPrompt: "u" });

    expect(mockFetch).toHaveBeenCalledWith(
      `${DEFAULT_OLLAMA_BASE_URL}/api/chat`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("parses a well-formed decide_action tool call with zero cost", async () => {
    mockFetchOnce(200, {
      message: {
        tool_calls: [
          {
            function: {
              name: "decide_action",
              arguments: { reasoning: "click it", actionType: "click", selector: "#go" },
            },
          },
        ],
      },
      prompt_eval_count: 100,
      eval_count: 10,
    });
    const provider = new OllamaModelProvider("llama3.1");

    const result = await provider.decide({ systemPrompt: "s", userPrompt: "u" });

    expect(result.decision.actionType).toBe("click");
    expect(result.usage.costUsd).toBe(0);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(10);
  });

  it("throws MalformedDecisionError with zero-cost usage when no tool call comes back", async () => {
    mockFetchOnce(200, {
      message: { content: "I decided not to call a tool" },
      prompt_eval_count: 20,
      eval_count: 8,
    });
    const provider = new OllamaModelProvider("a-model-with-no-tool-support");

    const err = await provider
      .decide({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedDecisionError);
    const malformed = err as InstanceType<typeof MalformedDecisionError>;
    expect(malformed.usage?.costUsd).toBe(0);
  });

  it("throws MalformedDecisionError when the tool call arguments fail validation", async () => {
    mockFetchOnce(200, {
      message: {
        tool_calls: [
          { function: { name: "decide_action", arguments: { actionType: "navigate" } } },
        ],
      },
    });
    const provider = new OllamaModelProvider("llama3.1");

    const err = await provider
      .decide({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedDecisionError);
    expect((err as Error).message).toMatch(/missing or empty 'reasoning'/);
  });

  it.each([
    [
      "an invalid actionType",
      { reasoning: "ok", actionType: "teleport" },
      /invalid actionType "teleport"/,
    ],
    [
      "a navigate decision missing url",
      { reasoning: "ok", actionType: "navigate" },
      /actionType 'navigate' requires 'url'/,
    ],
    [
      "a click decision missing selector",
      { reasoning: "ok", actionType: "click" },
      /actionType 'click' requires 'selector'/,
    ],
    [
      "a fill decision missing selector",
      { reasoning: "ok", actionType: "fill", value: "x" },
      /actionType 'fill' requires 'selector'/,
    ],
    [
      "a fill decision missing value",
      { reasoning: "ok", actionType: "fill", selector: "#x" },
      /actionType 'fill' requires 'value'/,
    ],
  ])("rejects %s", async (_label, args, messagePattern) => {
    mockFetchOnce(200, {
      message: {
        tool_calls: [{ function: { name: "decide_action", arguments: args } }],
      },
    });
    const provider = new OllamaModelProvider("llama3.1");

    const err = await provider
      .decide({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedDecisionError);
    expect((err as Error).message).toMatch(messagePattern);
  });

  it("throws a plain Error when the Ollama server responds with a non-OK status", async () => {
    mockFetchOnce(500, { error: "model not found" });
    const provider = new OllamaModelProvider("nonexistent-model");

    await expect(provider.decide({ systemPrompt: "s", userPrompt: "u" })).rejects.toThrow(
      /Ollama request .* failed: 500/,
    );
  });

  it("respects an explicit baseUrl override", async () => {
    const mockFetch = mockFetchOnce(200, {
      message: {
        tool_calls: [
          {
            function: {
              name: "decide_action",
              arguments: { reasoning: "go", actionType: "finish", outcome: "success" },
            },
          },
        ],
      },
    });
    const provider = new OllamaModelProvider("llama3.1", "http://remote-host:11434");

    await provider.decide({ systemPrompt: "s", userPrompt: "u" });

    expect(mockFetch).toHaveBeenCalledWith("http://remote-host:11434/api/chat", expect.anything());
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
