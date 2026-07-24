/**
 * SimConfig — the shape of a `sim.config.ts` file. Typed TypeScript config,
 * not JSON/YAML (CONTEXT.md "Open source packaging").
 */

export type ModelTier = "actor" | "analyst";

export interface ModelRoute {
  /** e.g. "anthropic", "ollama". Checked against dataPolicy at config load. */
  provider: string;
  /** Provider-specific model identifier. */
  model: string;
}

/** Discovery-mode run dimensions: org size x simulated weeks x session frequency. */
export interface RunDimensions {
  /** How many people the simulated org has (personas drawn from the pack). */
  orgSize: number;
  /** Simulated duration in weeks. */
  simulatedWeeks: number;
  /** Persona-sessions per persona per simulated week. */
  sessionsPerPersonaPerWeek: number;
}

/**
 * Both knobs are load-bearing (CONTEXT.md "Model routing & cost"): the hard
 * ceiling shuts the run down gracefully (never dies mid-write); the soft cap
 * ends a single persona-session gracefully so one runaway persona can't
 * consume the whole budget.
 */
export interface BudgetConfig {
  /** Hard dollar ceiling for the entire run. */
  runCeilingUsd: number;
  /** Soft dollar cap per persona-session. */
  perSessionSoftCapUsd: number;
  /**
   * Hard dollar ceiling for the analyst tier's single Batch API call per
   * `drover analyze` invocation. Checked pre-flight, against an estimate,
   * before the request is ever sent — a Batch call can't be capped
   * mid-flight the way a session's per-action loop can, since it's billed
   * the moment it's submitted. Unset means no analyst-tier cap (existing
   * behavior).
   * @default undefined
   */
  analystCeilingUsd?: number;
}

export interface SimConfig {
  /** Staging base URL. Never production. */
  targetBaseUrl: string;
  runDimensions: RunDimensions;
  budget: BudgetConfig;
  /** Model routing per tier (actor: cheap/swappable, analyst: Sonnet batch). */
  modelRouting: Record<ModelTier, ModelRoute>;
  /**
   * Sequential execution is the default; a cap above 1 is opt-in, never the
   * default path.
   * @default 1
   */
  concurrencyCap?: number;
}
