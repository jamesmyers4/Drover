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
 * Real input token counts aren't knowable without the provider's own
 * tokenizer, so this estimates from prompt character length (a standard
 * rough proxy) and assumes the configured max output tokens are fully used
 * — deliberately worst-case, since this gate only ever runs once, before
 * any cost has actually been billed.
 */

import { computeCostUsd, type TokenUsage } from "../actor/budget.js";
import { BATCH_DISCOUNT } from "./provider.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/** Worst-case Batch-discounted cost estimate for a single analyst call, before it's sent. */
export function estimateAnalystCostUsd(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
): number {
  const usage: TokenUsage = {
    inputTokens: estimateTokens(systemPrompt) + estimateTokens(userPrompt),
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
