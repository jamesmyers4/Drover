import { afterEach, describe, expect, it, vi } from "vitest";
import { computeCostUsd } from "../../src/actor/budget.js";
import { BATCH_DISCOUNT } from "../../src/analyst/provider.js";

// Same "mock the whole module" precedent tests/analyst/provider.test.ts and
// tests/actor/provider.test.ts both establish — the real SDK's `messages` is
// an instance property set in the constructor, not a prototype getter, so it
// can't be spied on after construction.
const { mockBatchCreate, mockBatchRetrieve, mockBatchResults } = vi.hoisted(() => ({
  mockBatchCreate: vi.fn(),
  mockBatchRetrieve: vi.fn(),
  mockBatchResults: vi.fn(),
}));
vi.mock("@anthropic-ai/sdk", () => ({
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
  BatchCrossTurnProvider,
  CrossTurnBatchError,
  DEFAULT_CROSS_TURN_MODEL,
  ScriptedCrossTurnProvider,
} = await import("../../src/soak/cross-turn-provider.js");

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
  input_tokens: 1500,
  output_tokens: 80,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function succeededLine(customId: string, findingsInput: unknown) {
  return {
    custom_id: customId,
    result: {
      type: "succeeded",
      message: {
        content: [{ type: "tool_use", name: "report_cross_turn_findings", input: findingsInput }],
        usage: BASE_USAGE,
      },
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ScriptedCrossTurnProvider", () => {
  it("returns the scripted findings and a fixed cost", async () => {
    const provider = new ScriptedCrossTurnProvider(
      [
        {
          type: "drift",
          severity: "medium",
          description: "Two turns diverge on the same variationId.",
          turnIds: ["t1", "t2"],
        },
      ],
      0.02,
    );

    const result = await provider.analyze({ systemPrompt: "s", userPrompt: "u" });
    expect(result.findings).toHaveLength(1);
    expect(result.usage.costUsd).toBe(0.02);
  });
});

describe("BatchCrossTurnProvider.analyze — real batch lifecycle", () => {
  it("happy path: create resolves already-ended, results yields the matching succeeded custom_id, findings + Batch-discounted cost come back", async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: "batch_1", processing_status: "ended" });
    const findingsInput = {
      findings: [
        {
          type: "recurring-error-cluster",
          severity: "high",
          description: "Several turns fail with the same root cause.",
          turnIds: ["t1", "t2", "t3"],
        },
      ],
    };
    mockBatchResults.mockResolvedValueOnce(
      asyncIterableOf([succeededLine("cross-turn-analysis", findingsInput)]),
    );

    const provider = new BatchCrossTurnProvider(DEFAULT_CROSS_TURN_MODEL, 0);
    const result = await provider.analyze({ systemPrompt: "s", userPrompt: "u" });

    expect(result.findings).toEqual(findingsInput.findings);
    const expectedCost =
      computeCostUsd(DEFAULT_CROSS_TURN_MODEL, {
        inputTokens: 1500,
        outputTokens: 80,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }) * BATCH_DISCOUNT;
    expect(result.usage.costUsd).toBeCloseTo(expectedCost, 10);
    expect(mockBatchRetrieve).not.toHaveBeenCalled();
    expect(mockBatchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [
          expect.objectContaining({
            custom_id: "cross-turn-analysis",
            params: expect.objectContaining({
              model: DEFAULT_CROSS_TURN_MODEL,
              tool_choice: { type: "tool", name: "report_cross_turn_findings" },
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
      asyncIterableOf([succeededLine("cross-turn-analysis", { findings: [] })]),
    );

    const provider = new BatchCrossTurnProvider(DEFAULT_CROSS_TURN_MODEL, 0);
    const result = await provider.analyze({ systemPrompt: "s", userPrompt: "u" });

    expect(result.findings).toEqual([]);
    expect(mockBatchRetrieve).toHaveBeenCalledTimes(2);
  });

  it("throws CrossTurnBatchError when no result in the stream matches the expected custom_id", async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: "batch_3", processing_status: "ended" });
    mockBatchResults.mockResolvedValueOnce(
      asyncIterableOf([succeededLine("some-other-custom-id", { findings: [] })]),
    );
    const provider = new BatchCrossTurnProvider(DEFAULT_CROSS_TURN_MODEL, 0);

    const err = await provider
      .analyze({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CrossTurnBatchError);
    expect((err as Error).message).toMatch(
      /no result for custom_id "cross-turn-analysis" in batch batch_3/,
    );
  });

  it("throws CrossTurnBatchError when the matching result did not succeed", async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: "batch_4", processing_status: "ended" });
    mockBatchResults.mockResolvedValueOnce(
      asyncIterableOf([{ custom_id: "cross-turn-analysis", result: { type: "errored" } }]),
    );
    const provider = new BatchCrossTurnProvider(DEFAULT_CROSS_TURN_MODEL, 0);

    const err = await provider
      .analyze({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CrossTurnBatchError);
    expect((err as Error).message).toMatch(/did not succeed \(result type: errored\)/);
  });

  it("throws CrossTurnBatchError when the succeeded message has no report_cross_turn_findings tool_use block", async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: "batch_5", processing_status: "ended" });
    mockBatchResults.mockResolvedValueOnce(
      asyncIterableOf([
        {
          custom_id: "cross-turn-analysis",
          result: {
            type: "succeeded",
            message: { content: [{ type: "text", text: "no tool call here" }], usage: BASE_USAGE },
          },
        },
      ]),
    );
    const provider = new BatchCrossTurnProvider(DEFAULT_CROSS_TURN_MODEL, 0);

    const err = await provider
      .analyze({ systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CrossTurnBatchError);
    expect((err as Error).message).toMatch(/no report_cross_turn_findings tool_use block/);
  });
});
