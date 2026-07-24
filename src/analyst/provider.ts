/**
 * Model client for the analyst tier (CONTEXT.md "Model routing & cost":
 * Sonnet, run via the Batch API since analysis is post-hoc with no latency
 * requirement — 50% off list price). CLAUDE.md Session 5.
 *
 * Structured output only, same discipline as the actor tier (CLAUDE.md
 * Session 3): a forced `report_cross_session_findings` tool call, never
 * free-text parsing. The provider interface hides the batch create/poll/
 * fetch-results lifecycle behind a single `analyze()` call so callers (and
 * tests) don't need to know it's async under the hood.
 */

import Anthropic from "@anthropic-ai/sdk";
import { computeCostUsd, type TokenUsage } from "../actor/budget.js";
import type { ModelRoute } from "../types/index.js";

export interface AnalystRequest {
  systemPrompt: string;
  userPrompt: string;
}

/** Unvalidated shape straight off the model's tool call — see validate.ts. */
export interface RawCrossSessionFinding {
  type?: unknown;
  severity?: unknown;
  description?: unknown;
  sessionIds?: unknown;
  route?: unknown;
}

export interface AnalystResponse {
  findings: RawCrossSessionFinding[];
  usage: TokenUsage & { costUsd: number };
}

export interface AnalystProvider {
  readonly provider: string;
  readonly model: string;
  analyze(request: AnalystRequest): Promise<AnalystResponse>;
}

export class AnalystBatchError extends Error {
  constructor(reason: string) {
    super(`Analyst batch request failed: ${reason}`);
    this.name = "AnalystBatchError";
  }
}

const REPORT_TOOL: Anthropic.Tool = {
  name: "report_cross_session_findings",
  description:
    "Report cross-session patterns found across the provided persona-session digests. Return an empty findings array if nothing rises to the level of a genuine cross-session pattern.",
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
              enum: [
                "duplicate-label",
                "repeated-stumble-route",
                "slow-checkpoint",
                "recurring-dead-end",
              ],
            },
            severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
            description: {
              type: "string",
              description: "One or two sentences describing the pattern and why it matters.",
            },
            sessionIds: {
              type: "array",
              items: { type: "string" },
              description: "The session ids (from the digests above) exhibiting this pattern.",
            },
            route: {
              type: "string",
              description:
                "The specific route, label, or checkpoint this pattern is anchored to — used as this finding's identity across future runs.",
            },
          },
          required: ["type", "severity", "description", "sessionIds", "route"],
        },
      },
    },
    required: ["findings"],
  },
};

/** Analyst tier default: Sonnet, per CONTEXT.md's model routing table. */
export const DEFAULT_ANALYST_MODEL = "claude-sonnet-5";
/** CONTEXT.md "Model routing & cost": Batch API is 50% off list price. */
export const BATCH_DISCOUNT = 0.5;
const DEFAULT_POLL_INTERVAL_MS = 5000;
/** Exported so budget.ts's pre-flight cost estimate uses the same worst-case output ceiling as the real request. */
export const DEFAULT_MAX_TOKENS = 4096;
const BATCH_CUSTOM_ID = "run-analysis";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFindings(input: unknown): RawCrossSessionFinding[] {
  if (typeof input !== "object" || input === null) return [];
  const findings = (input as { findings?: unknown }).findings;
  return Array.isArray(findings) ? (findings as RawCrossSessionFinding[]) : [];
}

export class BatchAnalystProvider implements AnalystProvider {
  readonly provider = "anthropic";
  private readonly client: Anthropic;

  constructor(
    readonly model: string = DEFAULT_ANALYST_MODEL,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {
    this.client = new Anthropic();
  }

  async analyze(request: AnalystRequest): Promise<AnalystResponse> {
    const created = await this.client.messages.batches.create({
      requests: [
        {
          custom_id: BATCH_CUSTOM_ID,
          params: {
            model: this.model,
            max_tokens: DEFAULT_MAX_TOKENS,
            system: request.systemPrompt,
            messages: [{ role: "user", content: request.userPrompt }],
            tools: [REPORT_TOOL],
            tool_choice: { type: "tool", name: "report_cross_session_findings" },
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
      throw new AnalystBatchError(
        `no result for custom_id "${BATCH_CUSTOM_ID}" in batch ${created.id}`,
      );
    }
    if (matched.result.type !== "succeeded") {
      throw new AnalystBatchError(`request did not succeed (result type: ${matched.result.type})`);
    }

    const message = matched.result.message;
    const block = message.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === "report_cross_session_findings",
    );
    if (!block) {
      throw new AnalystBatchError(
        "no report_cross_session_findings tool_use block in batch response",
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

/** Scripted/mocked provider for testing analyst mechanics without a real batch call. */
export class ScriptedAnalystProvider implements AnalystProvider {
  readonly provider = "scripted";
  readonly model = "scripted";

  constructor(
    private readonly response: RawCrossSessionFinding[],
    private readonly costUsd = 0,
  ) {}

  async analyze(): Promise<AnalystResponse> {
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

export function createAnalystProvider(
  route: ModelRoute,
  opts?: { pollIntervalMs?: number },
): AnalystProvider {
  switch (route.provider) {
    case "anthropic":
      return opts?.pollIntervalMs !== undefined
        ? new BatchAnalystProvider(route.model, opts.pollIntervalMs)
        : new BatchAnalystProvider(route.model);
    default:
      throw new Error(
        `Unsupported analyst-tier provider "${route.provider}" — only "anthropic" is implemented (Session 5).`,
      );
  }
}
