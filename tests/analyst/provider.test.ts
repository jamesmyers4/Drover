import { afterEach, describe, expect, it, vi } from "vitest";
import { computeCostUsd } from "../../src/actor/budget.js";

// The real SDK's `messages` is an instance property set in the constructor
// (`this.messages = new API.Messages(this)`), not a prototype getter, so it
// can't be spied on after construction — mock the whole module instead, same
// pattern tests/actor/provider.test.ts already established for
// AnthropicModelProvider. This also means these tests never need real
// ANTHROPIC_API_KEY credentials.
const { mockBatchCreate, mockBatchRetrieve, mockBatchResults } = vi.hoisted(() => ({
  mockBatchCreate: vi.fn(),
  mockBatchRetrieve: vi.fn(),
  mockBatchResults: vi.fn(),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  // A regular function, not an arrow function — arrow functions can't be
  // constructors, and `new Anthropic()` in provider.ts requires this to be
  // callable with `new`.
  default: vi.fn().mockImplementation(function MockAnthropic(this: { messages: unknown }) {
    this.messages = {
      batches: {
        create: mockBatchCreate,
        retrieve: mockBatchRetrieve,
        results: mockBatchResults,
      },
    };
  }),
}));

const {
  AnalystBatchError,
  BATCH_DISCOUNT,
  BatchAnalystProvider,
  createAnalystProvider,
  DEFAULT_ANALYST_MODEL,
  ScriptedAnalystProvider,
} = await import("../../src/analyst/provider.js");

/** Minimal async-iterable stand-in for the SDK's JSONLDecoder stream. */
function asyncIterableOf<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () =>
          i < items.length
            ? { value: items[i++] as T, done: false }
            : { value: undefined, done: true },
      };
    },
  };
}

const BASE_USAGE = {
  input_tokens: 2000,
  output_tokens: 100,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function succeededLine(customId: string, findingsInput: unknown) {
  return {
    custom_id: customId,
    result: {
      type: "succeeded",
      message: {
        content: [
          { type: "tool_use", name: "report_cross_session_findings", input: findingsInput },
        ],
        usage: BASE_USAGE,
      },
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createAnalystProvider", () => {
  it("builds a BatchAnalystProvider for provider 'anthropic'", () => {
    const provider = createAnalystProvider({ provider: "anthropic", model: DEFAULT_ANALYST_MODEL });
    expect(provider).toBeInstanceOf(BatchAnalystProvider);
    expect(provider.model).toBe(DEFAULT_ANALYST_MODEL);
  });

  it("rejects an unsupported provider", () => {
    expect(() => createAnalystProvider({ provider: "not-a-real-provider", model: "x" })).toThrow(
      /Unsupported analyst-tier provider/,
    );
  });
});

describe("ScriptedAnalystProvider", () => {
  it("returns the scripted findings and a fixed cost", async () => {
    const provider = new ScriptedAnalystProvider(
      [
        {
          type: "recurring-dead-end",
          severity: "medium",
          description: "Several sessions land on /help with no way forward.",
          sessionIds: ["s1", "s2"],
          route: "/help",
        },
      ],
      0.01,
    );

    const result = await provider.analyze({ systemPrompt: "s", userPrompt: "u" });
    expect(result.findings).toHaveLength(1);
    expect(result.usage.costUsd).toBe(0.01);
  });
});

describe("BatchAnalystProvider.analyze — real batch lifecycle", () => {
  it("happy path: create resolves already-ended, results yields the matching succeeded custom_id, findings + Batch-discounted cost come back", async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: "batch_1", processing_status: "ended" });
    const findingsInput = {
      findings: [
        {
          type: "recurring-dead-end",
          severity: "medium",
          description: "Several sessions land on /help with no way forward.",
          sessionIds: ["s1", "s2"],
          route: "/help",
        },
      ],
    };
    mockBatchResults.mockResolvedValueOnce(
      asyncIterableOf([succeededLine("run-analysis", findingsInput)]),
    );

    const provider = new BatchAnalystProvider(DEFAULT_ANALYST_MODEL, 0);
    const result = await provider.analyze({ systemPrompt: "s", userPrompt: "u" });

    expect(result.findings).toEqual(findingsInput.findings);
    const expectedCost =
      computeCostUsd(DEFAULT_ANALYST_MODEL, {
        inputTokens: 2000,
        outputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }) * BATCH_DISCOUNT;
    expect(result.usage.costUsd).toBeCloseTo(expectedCost, 10);
    // No polling needed — the batch was already "ended" on the create response.
    expect(mockBatchRetrieve).not.toHaveBeenCalled();
    expect(mockBatchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [
          expect.objectContaining({
            custom_id: "run-analysis",
            params: expect.objectContaining({
              model: DEFAULT_ANALYST_MODEL,
              tool_choice: { type: "tool", name: "report_cross_session_findings" },
            }),
          }),
        ],
      }),
    );
  });

  it("polls batches.retrieve until processing_status becomes 'ended' rather than returning early", async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: "batch_2", processing_status: "in_progress" });
    mockBatchRetrieve
      .mockResolvedValueOnce({ id: "batch_2", processing_status: "in_progress" })
      .mockResolvedValueOnce({ id: "batch_2", processing_status: "ended" });
    mockBatchResults.mockResolvedValueOnce(
      asyncIterableOf([succeededLine("run-analysis", { findings: [] })]),
    );

    // pollIntervalMs: 0 keeps the real setTimeout-based poll loop fast in tests.
    const provider = new BatchAnalystProvider(DEFAULT_ANALYST_MODEL, 0);
    const result = await provider.analyze({ systemPrompt: "s", userPrompt: "u" });

    expect(result.findings).toEqual([]);
    expect(mockBatchRetrieve).toHaveBeenCalledTimes(2);
    expect(mockBatchRetrieve).toHaveBeenNthCalledWith(1, "batch_2");
    expect(mockBatchRetrieve).toHaveBeenNthCalledWith(2, "batch_2");
  });

  it("throws AnalystBatchError when no result in the stream matches the expected custom_id", async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: "batch_3", processing_status: "ended" });
    mockBatchResults.mockResolvedValueOnce(
      asyncIterableOf([succeededLine("some-other-custom-id", { findings: [] })]),
    );
    const provider = new BatchAnalystProvider(DEFAULT_ANALYST_MODEL, 0);

    const err = await provider
      .analyze({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AnalystBatchError);
    expect((err as Error).message).toMatch(
      /no result for custom_id "run-analysis" in batch batch_3/,
    );
  });

  it("throws AnalystBatchError when the matching result did not succeed", async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: "batch_4", processing_status: "ended" });
    mockBatchResults.mockResolvedValueOnce(
      asyncIterableOf([{ custom_id: "run-analysis", result: { type: "errored" } }]),
    );
    const provider = new BatchAnalystProvider(DEFAULT_ANALYST_MODEL, 0);

    const err = await provider
      .analyze({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AnalystBatchError);
    expect((err as Error).message).toMatch(/did not succeed \(result type: errored\)/);
  });

  it("throws AnalystBatchError when the succeeded message has no report_cross_session_findings tool_use block", async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: "batch_5", processing_status: "ended" });
    mockBatchResults.mockResolvedValueOnce(
      asyncIterableOf([
        {
          custom_id: "run-analysis",
          result: {
            type: "succeeded",
            message: {
              content: [{ type: "text", text: "no tool call here" }],
              usage: BASE_USAGE,
            },
          },
        },
      ]),
    );
    const provider = new BatchAnalystProvider(DEFAULT_ANALYST_MODEL, 0);

    const err = await provider
      .analyze({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AnalystBatchError);
    expect((err as Error).message).toMatch(/no report_cross_session_findings tool_use block/);
  });
});
