/**
 * Local-model text variation for Soak mode's turns (CTS.md Soak Session 4)
 * — the last piece between Session 3's scheduler/dispatch mechanics and
 * CTS.md's original "a local LLM drives a blueprint continuously" framing.
 * Reuses `OllamaModelProvider`'s HTTP-calling pattern (`src/actor/provider.ts`)
 * against a new tool schema, `vary_narrative` — "lightly vary this example
 * narrative given these parameters," not `decide_action`.
 *
 * Ollama-only by construction (ADR 0009's consequence: the driver only
 * lightly varies pre-authored text, never freely generates) — unlike the
 * actor tier and Grader, there is no Anthropic implementation here. A
 * provider-level `dataPolicy` self-guard the way `AnthropicGraderProvider`
 * carries would be a tautology (`"ollama"` is always permitted, for every
 * `dataPolicy` value) — the real defense-in-depth re-check instead lives at
 * the actual dispatch site (`scheduler.ts`'s `dispatchTurn`), checking the
 * *constructed* provider's own `.provider` identity against the blueprint's
 * `dataPolicy` immediately before every `vary()` call, mirroring ADR 0002's
 * "one chokepoint isn't trusted alone" for Grader.
 */

import type { TokenUsage } from "../actor/budget.js";
import { buildVarySystemPrompt, buildVaryUserPrompt } from "./content-prompt.js";
import type { SoakBlueprint, VariationParams } from "./types.js";

export interface SoakVariationRequest {
  /** The Claude-authored example text drawn from the blueprint's variationPool (ADR 0009) — the driver varies this, never authors new content. */
  exampleText: string;
  variation?: VariationParams;
}

export interface SoakVariationResult {
  variedText: string;
  /** Always `{ costUsd: 0, ... }` for the real Ollama-only implementation (no per-token billing for a local model) — carried for observability parity with the actor/Grader tiers' own usage reporting, not because Soak's budget ever charges for it. */
  usage: TokenUsage & { costUsd: number };
}

export interface SoakContentProvider {
  readonly provider: string;
  readonly model: string;
  vary(request: SoakVariationRequest): Promise<SoakVariationResult>;
}

export class MalformedVariationError extends Error {
  constructor(reason: string) {
    super(`Driver model returned a malformed vary_narrative call: ${reason}`);
    this.name = "MalformedVariationError";
  }
}

class VariationParseError extends Error {}

function parseVariationResponse(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    throw new VariationParseError("tool input was not an object");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.variedText !== "string" || obj.variedText.trim().length === 0) {
    throw new VariationParseError("missing or empty 'variedText'");
  }
  return obj.variedText;
}

/** OpenAI-style function schema for Ollama's `tools` — same shape precedent as `OLLAMA_DECIDE_TOOL`/`OLLAMA_SCORE_TOOL`. No Anthropic-shaped twin exists (there is no Anthropic implementation of this provider — see this module's header comment). */
const OLLAMA_VARY_TOOL = {
  type: "function",
  function: {
    name: "vary_narrative",
    description:
      "Record the lightly-varied version of the given example narrative, following the stated constraints.",
    parameters: {
      type: "object",
      properties: {
        variedText: {
          type: "string",
          description: "The lightly-varied narrative text.",
        },
      },
      required: ["variedText"],
    },
  },
} as const;

interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Matches Ollama's own `OLLAMA_HOST` convention, same default `src/actor/provider.ts`/`src/grader/provider.ts` both use. */
export const DEFAULT_SOAK_OLLAMA_BASE_URL = "http://localhost:11434";

/**
 * Local/self-hosted provider via Ollama's `/api/chat` endpoint. Cost is
 * always `0` — no per-token billing for a local model, same treatment
 * `OllamaModelProvider`/`OllamaGraderProvider` both give it. A model with no
 * tool-calling support yields `MalformedVariationError` rather than a crash,
 * same "no tool_calls entry" handling those two providers already establish.
 */
export class OllamaSoakContentProvider implements SoakContentProvider {
  readonly provider = "ollama";
  private readonly baseUrl: string;

  constructor(
    readonly model: string,
    baseUrl?: string,
  ) {
    this.baseUrl = baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULT_SOAK_OLLAMA_BASE_URL;
  }

  async vary(request: SoakVariationRequest): Promise<SoakVariationResult> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: "system", content: buildVarySystemPrompt(request.variation) },
          { role: "user", content: buildVaryUserPrompt(request.exampleText) },
        ],
        tools: [OLLAMA_VARY_TOOL],
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

    const toolCall = body.message?.tool_calls?.find((c) => c.function?.name === "vary_narrative");
    if (!toolCall) {
      throw new MalformedVariationError("no vary_narrative tool call in Ollama response");
    }
    try {
      const variedText = parseVariationResponse(toolCall.function?.arguments);
      return { variedText, usage: billedUsage };
    } catch (err) {
      if (err instanceof VariationParseError) {
        throw new MalformedVariationError(err.message);
      }
      throw err;
    }
  }
}

/** Scripted/mocked provider for testing loop mechanics without a real model call — same script-array-with-exhaustion-error precedent as `ScriptedModelProvider`/`ScriptedGraderProvider`. */
export class ScriptedSoakContentProvider implements SoakContentProvider {
  readonly provider = "scripted";
  readonly model = "scripted";
  private index = 0;

  constructor(private readonly script: string[]) {}

  async vary(): Promise<SoakVariationResult> {
    const variedText = this.script[this.index];
    if (variedText === undefined) {
      throw new Error(`ScriptedSoakContentProvider script exhausted after ${this.index} calls`);
    }
    this.index++;
    return {
      variedText,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      },
    };
  }
}

/**
 * Constructs the real content provider for a blueprint's declared driver —
 * only `"ollama"` is implemented (ADR 0009: Soak's driver is Ollama-only by
 * construction), same switch-default-throw precedent `createModelProvider`
 * (`src/actor/provider.ts`) already establishes for an unsupported provider
 * string, rather than silently guessing or falling back.
 */
export function createSoakContentProvider(
  blueprint: Pick<SoakBlueprint, "driverProvider" | "driverModel">,
): SoakContentProvider {
  switch (blueprint.driverProvider) {
    case "ollama":
      return new OllamaSoakContentProvider(blueprint.driverModel);
    default:
      throw new Error(
        `Unsupported soak driver provider "${blueprint.driverProvider}" — only "ollama" is ` +
          "implemented (ADR 0009: Soak's driver is Ollama-only by construction).",
      );
  }
}
