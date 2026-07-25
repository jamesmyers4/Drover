/**
 * Model client behind a provider interface (CONTEXT.md "Model routing &
 * cost" / "Data routing & privacy"). The actor tier's only real
 * implementation in Session 3 is Anthropic (default Haiku); other providers
 * are a config-time choice for later sessions — see GAPS.md for the
 * Ollama/local-model gap.
 *
 * Structured output only: every decision comes back through a forced
 * `decide_action` tool call, never free-text parsing (CLAUDE.md Session 3).
 * Secrets discipline: nothing here ever puts auth tokens/cookies into
 * prompt content — the model only ever sees page perception text.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { DomainPack, ModelRoute } from "../types/index.js";
import { computeCostUsd, type TokenUsage } from "./budget.js";

export type ActorActionType = "navigate" | "click" | "fill" | "finish";

export interface ActorDecision {
  reasoning: string;
  actionType: ActorActionType;
  url?: string;
  selector?: string;
  value?: string;
  outcome?: "success" | "gave-up";
}

export interface ActorDecideRequest {
  /** Static, cacheable block — see src/actor/prompt.ts buildStaticSystemPrompt. */
  systemPrompt: string;
  /** Small per-action block — see buildActionPrompt. Never cached. */
  userPrompt: string;
}

export interface ActorDecideResult {
  decision: ActorDecision;
  usage: TokenUsage & { costUsd: number };
}

export interface ModelProvider {
  readonly provider: string;
  readonly model: string;
  decide(request: ActorDecideRequest): Promise<ActorDecideResult>;
}

export class MalformedDecisionError extends Error {
  /**
   * Set when the underlying API call itself succeeded (billed by the
   * provider) and only the tool-call payload failed to parse — lets callers
   * still record real spend against budget instead of losing it (GAPS.md:
   * "cost of a malformed decide_action call isn't recorded against budget").
   * Undefined when no API response was ever received (nothing was billed).
   */
  constructor(
    reason: string,
    readonly usage?: TokenUsage & { costUsd: number },
  ) {
    super(`Model returned a malformed decide_action call: ${reason}`);
    this.name = "MalformedDecisionError";
  }
}

/**
 * Soft cap on `reasoning`, not a hard schema rejection — CLAUDE.md's "one
 * sentence per action" is a prompt-adherence convention, and a model that
 * drifts into a longer explanation shouldn't crash the session over it
 * (GAPS.md). `maxLength` here is a hint to the model; `parseDecision` is what
 * actually enforces it, by truncating rather than throwing.
 */
export const MAX_REASONING_LENGTH = 200;

const DECIDE_TOOL: Anthropic.Tool = {
  name: "decide_action",
  description:
    "Record the single next action to take in the browser, and one short sentence of reasoning for it.",
  input_schema: {
    type: "object",
    properties: {
      reasoning: {
        type: "string",
        maxLength: MAX_REASONING_LENGTH,
        description: `One short first-person sentence: why you're doing this next. Keep it under ${MAX_REASONING_LENGTH} characters.`,
      },
      actionType: {
        type: "string",
        enum: ["navigate", "click", "fill", "finish"],
        description:
          "'finish' means the goal is complete or you're giving up (see outcome). Otherwise the browser action to take.",
      },
      url: {
        type: "string",
        description: "Destination URL. Required when actionType is 'navigate'.",
      },
      selector: {
        type: "string",
        description: "CSS selector of the element. Required when actionType is 'click' or 'fill'.",
      },
      value: { type: "string", description: "Text to type. Required when actionType is 'fill'." },
      outcome: {
        type: "string",
        enum: ["success", "gave-up"],
        description: "Required when actionType is 'finish'.",
      },
    },
    required: ["reasoning", "actionType"],
  },
};

/**
 * Thrown only internally by `parseDecision` — carries just the reason, never
 * usage (it doesn't know whether an API call was ever billed). `decide()`
 * catches this and re-throws the public `MalformedDecisionError` with
 * whatever billed usage it has on hand.
 */
class DecisionParseError extends Error {}

function parseDecision(input: unknown): ActorDecision {
  if (typeof input !== "object" || input === null) {
    throw new DecisionParseError("tool input was not an object");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.reasoning !== "string" || !obj.reasoning.trim()) {
    throw new DecisionParseError("missing or empty 'reasoning'");
  }
  const reasoning =
    obj.reasoning.length > MAX_REASONING_LENGTH
      ? `${obj.reasoning.slice(0, MAX_REASONING_LENGTH - 1)}…`
      : obj.reasoning;
  if (
    obj.actionType !== "navigate" &&
    obj.actionType !== "click" &&
    obj.actionType !== "fill" &&
    obj.actionType !== "finish"
  ) {
    throw new DecisionParseError(`invalid actionType "${String(obj.actionType)}"`);
  }
  const decision: ActorDecision = { reasoning, actionType: obj.actionType };
  if (typeof obj.url === "string") decision.url = obj.url;
  if (typeof obj.selector === "string") decision.selector = obj.selector;
  if (typeof obj.value === "string") decision.value = obj.value;
  if (obj.outcome === "success" || obj.outcome === "gave-up") decision.outcome = obj.outcome;

  if (decision.actionType === "navigate" && !decision.url) {
    throw new DecisionParseError("actionType 'navigate' requires 'url'");
  }
  if ((decision.actionType === "click" || decision.actionType === "fill") && !decision.selector) {
    throw new DecisionParseError(`actionType '${decision.actionType}' requires 'selector'`);
  }
  if (decision.actionType === "fill" && decision.value === undefined) {
    throw new DecisionParseError("actionType 'fill' requires 'value'");
  }
  return decision;
}

/** Actor tier default: cheap/swappable, real-time (CONTEXT.md model routing table). */
export const DEFAULT_ACTOR_MODEL = "claude-haiku-4-5";

export class AnthropicModelProvider implements ModelProvider {
  readonly provider = "anthropic";
  private readonly client: Anthropic;

  constructor(readonly model: string = DEFAULT_ACTOR_MODEL) {
    this.client = new Anthropic();
  }

  async decide(request: ActorDecideRequest): Promise<ActorDecideResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      system: [
        {
          type: "text",
          text: request.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: request.userPrompt }],
      tools: [DECIDE_TOOL],
      tool_choice: { type: "tool", name: "decide_action" },
    });

    // Computed unconditionally, before parsing — the API call is billed by
    // Anthropic as soon as `response` comes back, regardless of whether the
    // tool call inside it turns out to be well-formed.
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const billedUsage = { ...usage, costUsd: computeCostUsd(this.model, usage) };

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "decide_action",
    );
    if (!block) {
      throw new MalformedDecisionError("no decide_action tool_use block in response", billedUsage);
    }
    let decision: ActorDecision;
    try {
      decision = parseDecision(block.input);
    } catch (err) {
      if (err instanceof DecisionParseError)
        throw new MalformedDecisionError(err.message, billedUsage);
      throw err;
    }
    return { decision, usage: billedUsage };
  }
}

/** Scripted/mocked provider for testing loop mechanics without a real model call. */
export class ScriptedModelProvider implements ModelProvider {
  readonly provider = "scripted";
  readonly model = "scripted";
  private index = 0;

  constructor(
    private readonly script: ActorDecision[],
    private readonly costPerCallUsd = 0,
  ) {}

  async decide(): Promise<ActorDecideResult> {
    const decision = this.script[this.index];
    if (!decision) {
      throw new Error(`ScriptedModelProvider script exhausted after ${this.index} calls`);
    }
    this.index++;
    return {
      decision,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costUsd: this.costPerCallUsd,
      },
    };
  }
}

/**
 * Providers acceptable for `restricted` domain packs (CONTEXT.md "Data
 * routing & privacy"): Anthropic or another provider with clear contractual
 * data handling, or a fully local model. Only Anthropic is implemented as
 * of Session 3 — see GAPS.md for the Ollama/local-model gap.
 */
const APPROVED_RESTRICTED_PROVIDERS = new Set(["anthropic"]);

export class DataPolicyViolationError extends Error {
  constructor(dataPolicy: DomainPack["dataPolicy"], provider: string) {
    super(
      `dataPolicy "${dataPolicy}" does not permit actor-tier provider "${provider}". ` +
        'Restricted domain packs require an approved provider (see CONTEXT.md "Data routing & privacy").',
    );
    this.name = "DataPolicyViolationError";
  }
}

/** Enforced at config-load time, not advisory (CONTEXT.md). */
export function assertDataPolicyAllowed(
  dataPolicy: DomainPack["dataPolicy"],
  route: ModelRoute,
): void {
  if (dataPolicy === "restricted" && !APPROVED_RESTRICTED_PROVIDERS.has(route.provider)) {
    throw new DataPolicyViolationError(dataPolicy, route.provider);
  }
}

export function createModelProvider(route: ModelRoute): ModelProvider {
  switch (route.provider) {
    case "anthropic":
      return new AnthropicModelProvider(route.model);
    default:
      throw new Error(
        `Unsupported actor-tier provider "${route.provider}" — only "anthropic" is implemented (Session 3). See GAPS.md.`,
      );
  }
}
