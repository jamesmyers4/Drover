/**
 * Model client for the cross-turn pass (CTS.md Soak Session 6) —
 * architecturally mirrors the Analyst tier's `provider.ts` (Sonnet via the
 * Batch API, since this is post-hoc analysis with no latency requirement),
 * not a literal reuse: the tool schema is genuinely different
 * (`report_cross_turn_findings`, `turnIds` instead of `sessionIds`, no
 * `route` field, a different finding-type enum) — same "architecturally
 * mirrored... since a turn isn't a session" precedent ADR 0008 sets for the
 * whole cross-turn pass. `computeCostUsd`/`TokenUsage`/`BATCH_DISCOUNT` are
 * reused directly from the actor/analyst tiers — genuinely provider-shape-
 * agnostic, not tier-specific content.
 */

import Anthropic from "@anthropic-ai/sdk";
import { computeCostUsd, type TokenUsage } from "../actor/budget.js";
import { BATCH_DISCOUNT } from "../analyst/provider.js";

export interface CrossTurnRequest {
  systemPrompt: string;
  userPrompt: string;
}

/** Unvalidated shape straight off the model's tool call — see cross-turn-validate.ts. */
export interface RawCrossTurnFinding {
  type?: unknown;
  severity?: unknown;
  description?: unknown;
  turnIds?: unknown;
}

export interface CrossTurnResponse {
  findings: RawCrossTurnFinding[];
  usage: TokenUsage & { costUsd: number };
}

export interface CrossTurnProvider {
  readonly provider: string;
  readonly model: string;
  analyze(request: CrossTurnRequest): Promise<CrossTurnResponse>;
}

export class CrossTurnBatchError extends Error {
  constructor(reason: string) {
    super(`Cross-turn batch request failed: ${reason}`);
    this.name = "CrossTurnBatchError";
  }
}

const REPORT_CROSS_TURN_TOOL: Anthropic.Tool = {
  name: "report_cross_turn_findings",
  description:
    "Report cross-turn patterns found across the provided turn digests. Return an empty findings array if nothing rises to the level of a genuine cross-turn pattern.",
  input_schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["disagreement", "drift", "recurring-error-cluster"],
            },
            severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
            description: {
              type: "string",
              description: "One or two sentences describing the pattern and why it matters.",
            },
            turnIds: {
              type: "array",
              items: { type: "string" },
              description: "The turn ids (from the digests above) exhibiting this pattern.",
            },
          },
          required: ["type", "severity", "description", "turnIds"],
        },
      },
    },
    required: ["findings"],
  },
};

/** Reasonable default: same model the Analyst tier routes to (CONTEXT.md's model routing table names Sonnet for post-hoc batch analysis generally, not just session digests). */
export const DEFAULT_CROSS_TURN_MODEL = "claude-sonnet-5";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const BATCH_CUSTOM_ID = "cross-turn-analysis";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFindings(input: unknown): RawCrossTurnFinding[] {
  if (typeof input !== "object" || input === null) return [];
  const findings = (input as { findings?: unknown }).findings;
  return Array.isArray(findings) ? (findings as RawCrossTurnFinding[]) : [];
}

/** Real Batch API lifecycle — same create/poll/fetch-results shape `BatchAnalystProvider` already establishes (`src/analyst/provider.ts`). */
export class BatchCrossTurnProvider implements CrossTurnProvider {
  readonly provider = "anthropic";
  private readonly client: Anthropic;

  constructor(
    readonly model: string = DEFAULT_CROSS_TURN_MODEL,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {
    this.client = new Anthropic();
  }

  async analyze(request: CrossTurnRequest): Promise<CrossTurnResponse> {
    const created = await this.client.messages.batches.create({
      requests: [
        {
          custom_id: BATCH_CUSTOM_ID,
          params: {
            model: this.model,
            max_tokens: 4096,
            system: request.systemPrompt,
            messages: [{ role: "user", content: request.userPrompt }],
            tools: [REPORT_CROSS_TURN_TOOL],
            tool_choice: { type: "tool", name: "report_cross_turn_findings" },
          },
        },
      ],
    });

    let batch = created;
    while (batch.processing_status !== "ended") {
      await sleep(this.pollIntervalMs);
      batch = await this.client.messages.batches.retrieve(created.id);
    }

    const stream = await this.client.messages.batches.results(created.id);
    let matched: Anthropic.Messages.MessageBatchIndividualResponse | undefined;
    for await (const line of stream) {
      if (line.custom_id === BATCH_CUSTOM_ID) {
        matched = line;
        break;
      }
    }
    if (!matched) {
      throw new CrossTurnBatchError(
        `no result for custom_id "${BATCH_CUSTOM_ID}" in batch ${created.id}`,
      );
    }
    if (matched.result.type !== "succeeded") {
      throw new CrossTurnBatchError(
        `request did not succeed (result type: ${matched.result.type})`,
      );
    }

    const message = matched.result.message;
    const block = message.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === "report_cross_turn_findings",
    );
    if (!block) {
      throw new CrossTurnBatchError(
        "no report_cross_turn_findings tool_use block in batch response",
      );
    }

    const usage: TokenUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    };
    const costUsd = computeCostUsd(this.model, usage) * BATCH_DISCOUNT;

    return { findings: extractFindings(block.input), usage: { ...usage, costUsd } };
  }
}

/** Scripted/mocked provider for testing cross-turn mechanics without a real batch call. */
export class ScriptedCrossTurnProvider implements CrossTurnProvider {
  readonly provider = "scripted";
  readonly model = "scripted";

  constructor(
    private readonly response: RawCrossTurnFinding[],
    private readonly costUsd = 0,
  ) {}

  async analyze(_request?: CrossTurnRequest): Promise<CrossTurnResponse> {
    return {
      findings: this.response,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costUsd: this.costUsd,
      },
    };
  }
}
