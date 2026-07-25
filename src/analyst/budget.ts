/**
 * Pre-flight cost estimation for the analyst tier (GAPS.md "No budget
 * enforcement for the analyst tier"). Unlike the actor tier's
 * `SessionBudget` (src/actor/budget.ts), which records real per-call costs
 * and checks a soft cap between calls, the analyst tier makes exactly one
 * all-or-nothing Batch API call per `runAnalyst` invocation — it's billed
 * the moment it's submitted, so there's no "record and check" loop to hook
 * a cap into. The only place a ceiling can actually prevent overspend is a
 * pre-flight estimate checked *before* that submission.
 *
 * Input token counts come from Anthropic's real (free, non-billing)
 * `messages.countTokens` endpoint by default — exact, not estimated, and
 * counted against the same system+messages shape the real Batch request
 * uses. That's a network call needing real credentials, which this gate
 * can't assume are reachable (no `ANTHROPIC_API_KEY` has been available in
 * any build/test environment so far — see GAPS.md), so any failure to count
 * (missing credentials, offline, a flaky request) falls back to the old
 * chars/4 heuristic rather than blocking the pre-flight gate on tokenizer
 * availability. The output side still assumes the configured max output
 * tokens are fully used regardless of which input-counting path ran —
 * deliberately worst-case, since this gate only ever runs once, before any
 * cost has actually been billed.
 */

import Anthropic from "@anthropic-ai/sdk";
import { computeCostUsd, type TokenUsage } from "../actor/budget.js";
import { BATCH_DISCOUNT } from "./provider.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Fallback proxy, used only when the real `countTokens` API call fails or isn't reachable. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/** Counts input tokens for a system+user prompt pair. Swappable so tests can inject a fake without real credentials/network. */
export type TokenCounter = (systemPrompt: string, userPrompt: string) => Promise<number>;

/**
 * Real tokenizer via Anthropic's `messages.countTokens` endpoint — free of
 * charge, counts the exact system+messages shape `BatchAnalystProvider`
 * actually sends (CLAUDE.md: this is the accurate replacement for the old
 * chars/4 proxy). The client is constructed lazily, inside the returned
 * closure, so a missing API key surfaces as a rejected promise (catchable by
 * `estimateAnalystCostUsd`'s fallback) rather than throwing the moment this
 * factory is called.
 */
export function createApiTokenCounter(model: string): TokenCounter {
  return async (systemPrompt, userPrompt) => {
    const client = new Anthropic();
    const result = await client.messages.countTokens({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    return result.input_tokens;
  };
}

/**
 * Worst-case Batch-discounted cost estimate for a single analyst call,
 * before it's sent. Defaults to the real API-backed `TokenCounter`; pass one
 * explicitly (e.g. in tests) to avoid a real network call.
 */
export async function estimateAnalystCostUsd(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
  countTokens: TokenCounter = createApiTokenCounter(model),
): Promise<number> {
  let inputTokens: number;
  try {
    inputTokens = await countTokens(systemPrompt, userPrompt);
  } catch (err) {
    console.error(
      `[drover] analyst: real token count unavailable (${err instanceof Error ? err.message : String(err)}), falling back to the chars/4 estimate`,
    );
    inputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  }
  const usage: TokenUsage = {
    inputTokens,
    outputTokens: maxOutputTokens,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  return computeCostUsd(model, usage) * BATCH_DISCOUNT;
}

export class AnalystBudgetExceededError extends Error {
  constructor(
    readonly estimatedCostUsd: number,
    readonly ceilingUsd: number,
  ) {
    super(
      `Estimated analyst cost ($${estimatedCostUsd.toFixed(4)}) exceeds the configured budget.analystCeilingUsd ($${ceilingUsd.toFixed(4)}) — the Batch call was not sent. Raise the ceiling or reduce this run's session count.`,
    );
    this.name = "AnalystBudgetExceededError";
  }
}
