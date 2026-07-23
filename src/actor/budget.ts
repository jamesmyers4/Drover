/**
 * Cost accounting and budget enforcement (CONTEXT.md "Model routing & cost").
 * Two knobs are load-bearing: a hard per-run dollar ceiling (enforced by the
 * Session 4 orchestrator, which will aggregate `computeCostUsd` across
 * sessions) and a soft per-persona-session cap, enforced here by
 * `SessionBudget` — exceeding it ends the session gracefully, distinct from
 * a hard-stop bug.
 *
 * Pricing is approximate (Anthropic's standard cache multipliers — 1.25x
 * base input for a 5-minute-TTL cache write, 0.1x base input for a cache
 * read — applied to each model's list price) and will drift as pricing
 * changes; update PRICING when it does. Actor tier calls carry no thinking
 * tokens, so cost is input + cache write/read + output only.
 */

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerM: number;
  /** USD per 1,000,000 output tokens. */
  outputPerM: number;
}

/** Cached 2026-06-24 (see the claude-api skill's model table). Add entries as new models are routed. */
export const PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5": { inputPerM: 1.0, outputPerM: 5.0 },
  "claude-sonnet-5": { inputPerM: 3.0, outputPerM: 15.0 },
  "claude-opus-4-8": { inputPerM: 5.0, outputPerM: 25.0 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export class UnknownModelPricingError extends Error {
  constructor(model: string) {
    super(`No pricing entry for model "${model}" — add one to PRICING in src/actor/budget.ts`);
    this.name = "UnknownModelPricingError";
  }
}

export function computeCostUsd(model: string, usage: TokenUsage): number {
  const pricing = PRICING[model];
  if (!pricing) throw new UnknownModelPricingError(model);
  const cacheWritePerM = pricing.inputPerM * 1.25;
  const cacheReadPerM = pricing.inputPerM * 0.1;
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerM +
    (usage.outputTokens / 1_000_000) * pricing.outputPerM +
    (usage.cacheWriteTokens / 1_000_000) * cacheWritePerM +
    (usage.cacheReadTokens / 1_000_000) * cacheReadPerM
  );
}

/**
 * Per-session soft cap (CONTEXT.md: "one runaway persona can't consume the
 * whole budget alone"). Exceeding it is a graceful stop, not a crash — the
 * caller checks `exceeded` after each recorded call and ends the session
 * with status `budget-capped`.
 */
export class SessionBudget {
  private spentUsd = 0;

  constructor(readonly softCapUsd: number) {}

  record(costUsd: number): void {
    this.spentUsd += costUsd;
  }

  get spent(): number {
    return this.spentUsd;
  }

  get exceeded(): boolean {
    return this.spentUsd >= this.softCapUsd;
  }
}
