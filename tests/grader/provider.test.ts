import { afterEach, describe, expect, it, vi } from "vitest";

// Same mocking approach as tests/actor/provider.test.ts — the real SDK's
// `messages` is an instance property, not a prototype getter, so the whole
// module is mocked rather than spied on after construction. Means these
// tests never need real ANTHROPIC_API_KEY credentials.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function MockAnthropic(this: { messages: unknown }) {
    this.messages = { create: mockCreate };
  }),
}));

const {
  AnthropicGraderProvider,
  assertHostedGraderDispatchAllowed,
  createGraderModelProvider,
  DEFAULT_GRADER_OLLAMA_BASE_URL,
  DEFAULT_GRADER_OLLAMA_MODEL,
  DEFAULT_HOSTED_GRADER_MODEL,
  GraderDataPolicyViolationError,
  MalformedGraderResponseError,
  OllamaGraderProvider,
  ScriptedGraderProvider,
} = await import("../../src/grader/provider.js");
const { UnknownRubricError } = await import("../../src/grader/rubric.js");

import type { Rubric } from "../../src/grader/types.js";

const BASE_USAGE = {
  input_tokens: 500,
  output_tokens: 40,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const toneRubric: Rubric = {
  key: "tone-eval",
  description: "Scores tone and overall quality.",
  checks: [
    { name: "on-brand-tone", description: "Reads as warm, not clinical.", scoringType: "boolean" },
    {
      name: "quality-score",
      description: "1-5 overall quality.",
      scoringType: "numeric",
      numericTolerance: 0.5,
      passThreshold: { comparison: "gte", value: 3 },
    },
  ],
};

describe("assertHostedGraderDispatchAllowed", () => {
  it("throws for a restricted pack when allowHostedEscalation is unset", () => {
    expect(() => assertHostedGraderDispatchAllowed({ dataPolicy: "restricted" })).toThrow(
      GraderDataPolicyViolationError,
    );
  });

  it("throws for a restricted pack when allowHostedEscalation is explicitly false", () => {
    expect(() =>
      assertHostedGraderDispatchAllowed({ dataPolicy: "restricted", allowHostedEscalation: false }),
    ).toThrow(GraderDataPolicyViolationError);
  });

  it("allows dispatch for a restricted pack once allowHostedEscalation is explicitly true", () => {
    expect(() =>
      assertHostedGraderDispatchAllowed({ dataPolicy: "restricted", allowHostedEscalation: true }),
    ).not.toThrow();
  });

  it("allows dispatch for a synthetic-only pack even without allowHostedEscalation set — nothing sensitive to gate", () => {
    expect(() => assertHostedGraderDispatchAllowed({ dataPolicy: "synthetic-only" })).not.toThrow();
    expect(() =>
      assertHostedGraderDispatchAllowed({
        dataPolicy: "synthetic-only",
        allowHostedEscalation: false,
      }),
    ).not.toThrow();
  });
});

describe("createGraderModelProvider", () => {
  it("builds an OllamaGraderProvider for provider 'ollama'", () => {
    const provider = createGraderModelProvider(
      { provider: "ollama", model: "qwen2.5" },
      { dataPolicy: "synthetic-only" },
    );
    expect(provider).toBeInstanceOf(OllamaGraderProvider);
    expect(provider.model).toBe("qwen2.5");
  });

  it("builds an AnthropicGraderProvider for provider 'anthropic' for a synthetic-only pack, no flag needed", () => {
    const provider = createGraderModelProvider(
      { provider: "anthropic", model: DEFAULT_HOSTED_GRADER_MODEL },
      { dataPolicy: "synthetic-only" },
    );
    expect(provider).toBeInstanceOf(AnthropicGraderProvider);
  });

  it("builds an AnthropicGraderProvider for a restricted pack once allowHostedEscalation is true", () => {
    const provider = createGraderModelProvider(
      { provider: "anthropic", model: DEFAULT_HOSTED_GRADER_MODEL },
      { dataPolicy: "restricted", allowHostedEscalation: true },
    );
    expect(provider).toBeInstanceOf(AnthropicGraderProvider);
  });

  it("refuses to build an AnthropicGraderProvider for a restricted pack when allowHostedEscalation isn't true", () => {
    expect(() =>
      createGraderModelProvider(
        { provider: "anthropic", model: DEFAULT_HOSTED_GRADER_MODEL },
        { dataPolicy: "restricted" },
      ),
    ).toThrow(GraderDataPolicyViolationError);
  });

  it("rejects an unsupported provider", () => {
    expect(() =>
      createGraderModelProvider(
        { provider: "not-real", model: "x" },
        { dataPolicy: "synthetic-only" },
      ),
    ).toThrow(/Unsupported grader-tier provider/);
  });
});

describe("AnthropicGraderProvider", () => {
  it("refuses to construct for a restricted pack without allowHostedEscalation: true", () => {
    expect(() => new AnthropicGraderProvider({ dataPolicy: "restricted" })).toThrow(
      GraderDataPolicyViolationError,
    );
  });

  it("constructs for a synthetic-only pack without needing allowHostedEscalation", () => {
    expect(() => new AnthropicGraderProvider({ dataPolicy: "synthetic-only" })).not.toThrow();
  });

  it("scores every rubric Check from a well-formed score_checks tool call", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "score_checks",
          input: {
            checks: [
              { name: "on-brand-tone", value: true, reasoning: "Warm greeting." },
              { name: "quality-score", value: 4, reasoning: "Solid, minor nitpicks." },
            ],
          },
        },
      ],
      usage: BASE_USAGE,
    });
    const provider = new AnthropicGraderProvider(
      { dataPolicy: "synthetic-only", allowHostedEscalation: true },
      DEFAULT_HOSTED_GRADER_MODEL,
    );

    const result = await provider.score({
      input: { prompt: "hi" },
      output: { text: "hello!" },
      rubric: toneRubric,
      framing: "Judge the output.",
    });

    expect(result.checks).toEqual([
      { name: "on-brand-tone", value: true, reasoning: "Warm greeting." },
      { name: "quality-score", value: 4, reasoning: "Solid, minor nitpicks." },
    ]);
    expect(result.usage.costUsd).toBeGreaterThan(0);
  });

  it("attaches billed usage to MalformedGraderResponseError when no score_checks block comes back", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "oops" }],
      usage: BASE_USAGE,
    });
    const provider = new AnthropicGraderProvider({
      dataPolicy: "synthetic-only",
      allowHostedEscalation: true,
    });

    const err = await provider
      .score({ input: {}, output: {}, rubric: toneRubric, framing: "x" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedGraderResponseError);
    expect(
      (err as InstanceType<typeof MalformedGraderResponseError>).usage?.costUsd,
    ).toBeGreaterThan(0);
  });

  it("throws MalformedGraderResponseError when a rubric Check is missing from the response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "score_checks",
          input: { checks: [{ name: "on-brand-tone", value: true, reasoning: "ok" }] },
        },
      ],
      usage: BASE_USAGE,
    });
    const provider = new AnthropicGraderProvider({
      dataPolicy: "synthetic-only",
      allowHostedEscalation: true,
    });

    const err = await provider
      .score({ input: {}, output: {}, rubric: toneRubric, framing: "x" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedGraderResponseError);
    expect((err as Error).message).toMatch(/missing Check "quality-score"/);
  });

  it("throws MalformedGraderResponseError when a Check's value has the wrong scoring type", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "score_checks",
          input: {
            checks: [
              { name: "on-brand-tone", value: "yes", reasoning: "ok" },
              { name: "quality-score", value: 4, reasoning: "ok" },
            ],
          },
        },
      ],
      usage: BASE_USAGE,
    });
    const provider = new AnthropicGraderProvider({
      dataPolicy: "synthetic-only",
      allowHostedEscalation: true,
    });

    const err = await provider
      .score({ input: {}, output: {}, rubric: toneRubric, framing: "x" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedGraderResponseError);
    expect((err as Error).message).toMatch(/expects a boolean value/);
  });
});

describe("OllamaGraderProvider", () => {
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
              name: "score_checks",
              arguments: {
                checks: [
                  { name: "on-brand-tone", value: true, reasoning: "ok" },
                  { name: "quality-score", value: 3, reasoning: "ok" },
                ],
              },
            },
          },
        ],
      },
      prompt_eval_count: 50,
      eval_count: 5,
    });
    const provider = new OllamaGraderProvider(DEFAULT_GRADER_OLLAMA_MODEL);

    await provider.score({ input: {}, output: {}, rubric: toneRubric, framing: "x" });

    expect(mockFetch).toHaveBeenCalledWith(
      `${DEFAULT_GRADER_OLLAMA_BASE_URL}/api/chat`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("parses a well-formed score_checks tool call with zero cost", async () => {
    mockFetchOnce(200, {
      message: {
        tool_calls: [
          {
            function: {
              name: "score_checks",
              arguments: {
                checks: [
                  { name: "on-brand-tone", value: false, reasoning: "Too clinical." },
                  { name: "quality-score", value: 2, reasoning: "Weak." },
                ],
              },
            },
          },
        ],
      },
      prompt_eval_count: 100,
      eval_count: 10,
    });
    const provider = new OllamaGraderProvider(DEFAULT_GRADER_OLLAMA_MODEL);

    const result = await provider.score({
      input: {},
      output: {},
      rubric: toneRubric,
      framing: "x",
    });

    expect(result.checks).toEqual([
      { name: "on-brand-tone", value: false, reasoning: "Too clinical." },
      { name: "quality-score", value: 2, reasoning: "Weak." },
    ]);
    expect(result.usage.costUsd).toBe(0);
    expect(result.usage.inputTokens).toBe(100);
  });

  it("throws MalformedGraderResponseError with zero-cost usage when no tool call comes back", async () => {
    mockFetchOnce(200, {
      message: { content: "I decided not to call a tool" },
      prompt_eval_count: 20,
      eval_count: 8,
    });
    const provider = new OllamaGraderProvider("a-model-with-no-tool-support");

    const err = await provider
      .score({ input: {}, output: {}, rubric: toneRubric, framing: "x" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedGraderResponseError);
    expect((err as InstanceType<typeof MalformedGraderResponseError>).usage?.costUsd).toBe(0);
  });

  it("throws a plain Error when the Ollama server responds with a non-OK status", async () => {
    mockFetchOnce(500, { error: "model not found" });
    const provider = new OllamaGraderProvider("nonexistent-model");

    await expect(
      provider.score({ input: {}, output: {}, rubric: toneRubric, framing: "x" }),
    ).rejects.toThrow(/Ollama request .* failed: 500/);
  });

  it("respects an explicit baseUrl override", async () => {
    const mockFetch = mockFetchOnce(200, {
      message: {
        tool_calls: [
          {
            function: {
              name: "score_checks",
              arguments: {
                checks: [
                  { name: "on-brand-tone", value: true, reasoning: "ok" },
                  { name: "quality-score", value: 5, reasoning: "ok" },
                ],
              },
            },
          },
        ],
      },
    });
    const provider = new OllamaGraderProvider(
      DEFAULT_GRADER_OLLAMA_MODEL,
      "http://remote-host:11434",
    );

    await provider.score({ input: {}, output: {}, rubric: toneRubric, framing: "x" });

    expect(mockFetch).toHaveBeenCalledWith("http://remote-host:11434/api/chat", expect.anything());
  });

  it("ignores an unrecognized extra Check entry in the response rather than erroring", async () => {
    mockFetchOnce(200, {
      message: {
        tool_calls: [
          {
            function: {
              name: "score_checks",
              arguments: {
                checks: [
                  { name: "on-brand-tone", value: true, reasoning: "ok" },
                  { name: "quality-score", value: 5, reasoning: "ok" },
                  { name: "not-a-real-check", value: true, reasoning: "extra" },
                ],
              },
            },
          },
        ],
      },
    });
    const provider = new OllamaGraderProvider(DEFAULT_GRADER_OLLAMA_MODEL);

    const result = await provider.score({
      input: {},
      output: {},
      rubric: toneRubric,
      framing: "x",
    });
    expect(result.checks).toHaveLength(2);
  });
});

describe("ScriptedGraderProvider", () => {
  it("replays scripted checks in order and reports a fixed cost per call", async () => {
    const provider = new ScriptedGraderProvider(
      [
        [{ name: "on-brand-tone", value: true, reasoning: "a" }],
        [{ name: "on-brand-tone", value: false, reasoning: "b" }],
      ],
      0.01,
    );

    const first = await provider.score();
    const second = await provider.score();

    expect(first.checks[0]?.value).toBe(true);
    expect(second.checks[0]?.value).toBe(false);
    expect(first.usage.costUsd).toBe(0.01);
  });

  it("throws once the script is exhausted", async () => {
    const provider = new ScriptedGraderProvider([[{ name: "x", value: true, reasoning: "a" }]]);
    await provider.score();
    await expect(provider.score()).rejects.toThrow(/script exhausted/);
  });
});

// Sanity: confirms rubric.ts's own error type is distinct from this module's
// (used by judge-layer.ts, not provider.ts, but exercised here since it's
// the natural neighbor of "what happens with an unresolvable rubric").
describe("UnknownRubricError", () => {
  it("is a distinct error type from the provider module's own errors", () => {
    expect(new UnknownRubricError("missing-key")).not.toBeInstanceOf(
      GraderDataPolicyViolationError,
    );
  });
});
