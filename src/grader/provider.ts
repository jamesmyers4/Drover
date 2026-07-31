/**
 * Model client behind a Grader-specific provider interface (FUTUREPLAN.md
 * Grader Session 4). Deliberately a separate interface from the actor
 * tier's `ModelProvider` (`src/actor/provider.ts`), not a reuse of it — the
 * tool-call shape is fundamentally different: a structured multi-Check
 * score+reasoning payload (`score_checks`), not a single `decide_action`.
 * `TokenUsage`/`computeCostUsd` and the "one sentence, truncate don't
 * reject" reasoning-length discipline *are* reused directly from the actor
 * tier (`src/actor/budget.ts`, `src/actor/provider.ts`'s
 * `MAX_REASONING_LENGTH`) — those are genuinely provider-shape-agnostic.
 *
 * Two real implementations, mirroring the actor tier's split: `OllamaGraderProvider`
 * (local/self-hosted, the expected default for routine Grader operation —
 * see FUTUREPLAN.md's cost-basis note) and `AnthropicGraderProvider` (hosted,
 * gated by `assertHostedGraderDispatchAllowed` per ADR 0002 — see that
 * function's doc comment for the `dataPolicy`/`allowHostedEscalation`
 * interaction it enforces). `ScriptedGraderProvider` is the test double.
 */

import Anthropic from "@anthropic-ai/sdk";
import { computeCostUsd, type TokenUsage } from "../actor/budget.js";
import { MAX_REASONING_LENGTH } from "../actor/provider.js";
import type { ModelRoute } from "../types/index.js";
import { buildScoreSystemPrompt, buildScoreUserPrompt } from "./prompt.js";
import type { CheckDefinition, CheckResult, GraderPack, Rubric } from "./types.js";

export interface GraderScoreRequest {
  input: unknown;
  output: unknown;
  rubric: Rubric;
  /** Distinguishes e.g. Layer 2's golden-regression framing from Layer 3's open judge framing — see prompt.ts. */
  framing: string;
}

export interface GraderScoreResult {
  checks: CheckResult[];
  usage: TokenUsage & { costUsd: number };
}

export interface GraderModelProvider {
  readonly provider: string;
  readonly model: string;
  /** Family-level identity (ADR 0003) — distinct from `model` so a future quantization variant of the same base model can share a family without a code change. */
  readonly modelFamily: string;
  /** Which physical box/endpoint this provider dispatches to (ADR 0004) — recorded even under v1's fully-sequential dispatch. */
  readonly executionTarget: string;
  score(request: GraderScoreRequest): Promise<GraderScoreResult>;
}

export class MalformedGraderResponseError extends Error {
  /** Set only when the underlying API call itself was billed — mirrors `MalformedDecisionError`'s same reasoning (`src/actor/provider.ts`). */
  constructor(
    reason: string,
    readonly usage?: TokenUsage & { costUsd: number },
  ) {
    super(`Judge model returned a malformed score_checks call: ${reason}`);
    this.name = "MalformedGraderResponseError";
  }
}

/** Thrown only internally by `parseScoreResponse`; each provider re-throws it as the public `MalformedGraderResponseError` with whatever billed usage it has on hand. */
class ScoreParseError extends Error {}

function isCheckValueWellTyped(def: CheckDefinition, value: unknown): boolean {
  return def.scoringType === "boolean"
    ? typeof value === "boolean"
    : typeof value === "number" && Number.isFinite(value);
}

/**
 * Parses one judge call's `score_checks` payload against the rubric that
 * was actually sent, in the rubric's own Check order (not whatever order
 * the model happened to return them in — deterministic persistence). Every
 * Check the rubric declares must appear in the response; an extra,
 * unrecognized entry is silently ignored rather than treated as an error
 * (a judge padding its answer with something unasked-for isn't itself a
 * failure worth crashing the Task over).
 */
function parseScoreResponse(rubric: Rubric, input: unknown): CheckResult[] {
  if (typeof input !== "object" || input === null) {
    throw new ScoreParseError("tool input was not an object");
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.checks)) {
    throw new ScoreParseError("missing or non-array 'checks'");
  }

  const byName = new Map<string, Record<string, unknown>>();
  for (const raw of obj.checks) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { name?: unknown }).name === "string"
    ) {
      byName.set((raw as { name: string }).name, raw as Record<string, unknown>);
    }
  }

  const results: CheckResult[] = [];
  for (const def of rubric.checks) {
    const entry = byName.get(def.name);
    if (!entry) {
      throw new ScoreParseError(`missing Check "${def.name}" in judge response`);
    }
    if (!isCheckValueWellTyped(def, entry.value)) {
      throw new ScoreParseError(
        `Check "${def.name}" expects a ${def.scoringType} value, got ${typeof entry.value}`,
      );
    }
    if (typeof entry.reasoning !== "string" || !entry.reasoning.trim()) {
      throw new ScoreParseError(`Check "${def.name}" is missing non-empty 'reasoning'`);
    }
    const reasoning =
      entry.reasoning.length > MAX_REASONING_LENGTH
        ? `${entry.reasoning.slice(0, MAX_REASONING_LENGTH - 1)}…`
        : entry.reasoning;
    results.push({ name: def.name, value: entry.value as boolean | number, reasoning });
  }
  return results;
}

const SCORE_TOOL: Anthropic.Tool = {
  name: "score_checks",
  description:
    "Record a value and one short sentence of reasoning for every named Check listed in the system prompt's rubric.",
  input_schema: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Must exactly match one of the Check names listed in the system prompt.",
            },
            value: {
              description:
                "true/false for a boolean Check, or a number for a numeric Check — matching that Check's own scoring type exactly.",
            },
            reasoning: {
              type: "string",
              maxLength: MAX_REASONING_LENGTH,
              description: `One short sentence explaining this Check's value. Keep it under ${MAX_REASONING_LENGTH} characters.`,
            },
          },
          required: ["name", "value", "reasoning"],
        },
      },
    },
    required: ["checks"],
  },
};

/** Same schema as `SCORE_TOOL.input_schema`, framed as an OpenAI-style function for Ollama's `tools` — same precedent as `OLLAMA_DECIDE_TOOL` in `src/actor/provider.ts`. */
const OLLAMA_SCORE_TOOL = {
  type: "function",
  function: {
    name: SCORE_TOOL.name,
    description: SCORE_TOOL.description,
    parameters: SCORE_TOOL.input_schema,
  },
} as const;

/**
 * Gate for any hosted (Anthropic) grader-judge dispatch (ADR 0002), scoped
 * to `restricted` packs only — a `synthetic-only` pack has no sensitive
 * content to gate hosted exposure against in the first place, so it may use
 * Anthropic without declaring `allowHostedEscalation` at all, same as the
 * actor tier's `assertDataPolicyAllowed` allowing any provider for
 * `synthetic-only` domain packs.
 *
 * Corrected after Session 4's first pass, which checked
 * `allowHostedEscalation` unconditionally — a literal reading of ADR 0002's
 * transcribed text, but not what Question 9 actually proposed (the flag as
 * something "a restricted pack must set true," not a universal toggle). The
 * unconditional version was strictly more conservative, not unsafe, but it
 * cost `synthetic-only` packs a flag they have no exposure to be protected
 * from — friction without a corresponding safety benefit. This is the
 * deliberate, confirmed reading; see ADR 0002's amendment note for the full
 * record.
 */
export class GraderDataPolicyViolationError extends Error {
  constructor(dataPolicy: GraderPack["dataPolicy"]) {
    super(
      `dataPolicy "${dataPolicy}" requires GraderPack.allowHostedEscalation to be explicitly ` +
        "true before a hosted (Anthropic) grader judge may construct or execute. See " +
        "docs/adr/0002-grader-datapolicy-fail-closed-escalation.md.",
    );
    this.name = "GraderDataPolicyViolationError";
  }
}

export function assertHostedGraderDispatchAllowed(
  pack: Pick<GraderPack, "dataPolicy" | "allowHostedEscalation">,
): void {
  if (pack.dataPolicy === "restricted" && pack.allowHostedEscalation !== true) {
    throw new GraderDataPolicyViolationError(pack.dataPolicy);
  }
}

/** Local/self-hosted default judge model — swap for whatever's actually installed; no name is locked in (FUTUREPLAN.md §3). */
export const DEFAULT_GRADER_OLLAMA_MODEL = "qwen2.5";
/** Matches Ollama's own `OLLAMA_HOST` convention, same default `src/actor/provider.ts` uses. */
export const DEFAULT_GRADER_OLLAMA_BASE_URL = "http://localhost:11434";

interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Local/self-hosted provider via Ollama's `/api/chat` — the expected
 * default for routine Grader operation (FUTUREPLAN.md cost-basis note: $0
 * by design). Reuses `OllamaModelProvider`'s HTTP-calling pattern
 * (`src/actor/provider.ts`) but with `score_checks`'s tool schema instead
 * of `decide_action` — same "no per-token billing for a local model, cost
 * is always 0" treatment. `executionTarget` is this instance's base URL —
 * the closest thing to "which box" a local HTTP endpoint has.
 */
export class OllamaGraderProvider implements GraderModelProvider {
  readonly provider = "ollama";
  readonly modelFamily: string;
  readonly executionTarget: string;
  private readonly baseUrl: string;

  constructor(
    readonly model: string = DEFAULT_GRADER_OLLAMA_MODEL,
    baseUrl?: string,
  ) {
    this.baseUrl = baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULT_GRADER_OLLAMA_BASE_URL;
    this.modelFamily = model;
    this.executionTarget = this.baseUrl;
  }

  async score(request: GraderScoreRequest): Promise<GraderScoreResult> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: "system", content: buildScoreSystemPrompt(request.framing, request.rubric) },
          { role: "user", content: buildScoreUserPrompt(request.input, request.output) },
        ],
        tools: [OLLAMA_SCORE_TOOL],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Ollama request to ${this.baseUrl} failed: ${response.status} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as OllamaChatResponse;

    const usage: TokenUsage = {
      inputTokens: body.prompt_eval_count ?? 0,
      outputTokens: body.eval_count ?? 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };
    const billedUsage = { ...usage, costUsd: 0 };

    const toolCall = body.message?.tool_calls?.find((c) => c.function?.name === "score_checks");
    if (!toolCall) {
      throw new MalformedGraderResponseError(
        "no score_checks tool call in Ollama response",
        billedUsage,
      );
    }
    let checks: CheckResult[];
    try {
      checks = parseScoreResponse(request.rubric, toolCall.function?.arguments);
    } catch (err) {
      if (err instanceof ScoreParseError) {
        throw new MalformedGraderResponseError(err.message, billedUsage);
      }
      throw err;
    }
    return { checks, usage: billedUsage };
  }
}

/** Reasonable hosted default — cheap, matches the actor tier's own default model. Session 5's escalation path may want a different (e.g. stronger-reasoning) model; nothing here forces it. */
export const DEFAULT_HOSTED_GRADER_MODEL = "claude-haiku-4-5";

/**
 * Hosted (Anthropic) judge provider. Gated by `assertHostedGraderDispatchAllowed`
 * at **both** construction and every `score()` call — "refuses to
 * construct/execute" per FUTUREPLAN.md Session 4's own wording — even
 * though nothing in Session 4 actually calls this provider yet (Layer 2/3
 * dispatch to a local judge only). This is the provider-level half of
 * ADR 0002's defense-in-depth; Session 5 adds the second half, a scheduler-
 * level check immediately before any real escalation dispatch.
 */
export class AnthropicGraderProvider implements GraderModelProvider {
  readonly provider = "anthropic";
  readonly modelFamily: string;
  readonly executionTarget = "anthropic-hosted";
  private readonly client: Anthropic;

  constructor(
    private readonly pack: Pick<GraderPack, "dataPolicy" | "allowHostedEscalation">,
    readonly model: string = DEFAULT_HOSTED_GRADER_MODEL,
  ) {
    assertHostedGraderDispatchAllowed(pack);
    this.modelFamily = model;
    this.client = new Anthropic();
  }

  async score(request: GraderScoreRequest): Promise<GraderScoreResult> {
    assertHostedGraderDispatchAllowed(this.pack);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: buildScoreSystemPrompt(request.framing, request.rubric),
      messages: [{ role: "user", content: buildScoreUserPrompt(request.input, request.output) }],
      tools: [SCORE_TOOL],
      tool_choice: { type: "tool", name: "score_checks" },
    });

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const billedUsage = { ...usage, costUsd: computeCostUsd(this.model, usage) };

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "score_checks",
    );
    if (!block) {
      throw new MalformedGraderResponseError(
        "no score_checks tool_use block in response",
        billedUsage,
      );
    }
    let checks: CheckResult[];
    try {
      checks = parseScoreResponse(request.rubric, block.input);
    } catch (err) {
      if (err instanceof ScoreParseError) {
        throw new MalformedGraderResponseError(err.message, billedUsage);
      }
      throw err;
    }
    return { checks, usage: billedUsage };
  }
}

/** Scripted/mocked provider for testing dispatch mechanics without a real model call — same script-array precedent as `ScriptedModelProvider`/`ScriptedAnalystProvider`. */
export class ScriptedGraderProvider implements GraderModelProvider {
  readonly provider = "scripted";
  readonly model = "scripted";
  readonly modelFamily = "scripted";
  readonly executionTarget = "scripted";
  private index = 0;

  constructor(
    private readonly script: CheckResult[][],
    private readonly costPerCallUsd = 0,
  ) {}

  async score(): Promise<GraderScoreResult> {
    const checks = this.script[this.index];
    if (!checks) {
      throw new Error(`ScriptedGraderProvider script exhausted after ${this.index} calls`);
    }
    this.index++;
    return {
      checks,
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

export function createGraderModelProvider(
  route: ModelRoute,
  pack: Pick<GraderPack, "dataPolicy" | "allowHostedEscalation">,
): GraderModelProvider {
  switch (route.provider) {
    case "ollama":
      return new OllamaGraderProvider(route.model);
    case "anthropic":
      return new AnthropicGraderProvider(pack, route.model);
    default:
      throw new Error(
        `Unsupported grader-tier provider "${route.provider}" — only "ollama" and "anthropic" are implemented.`,
      );
  }
}
