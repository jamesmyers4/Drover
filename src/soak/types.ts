/**
 * Soak mode core types — a separate subsystem (docs/adr/0006-0010,
 * CONTEXT.md Glossary "Soak mode"), not a DomainPack/SimConfig extension.
 * Storage lives in `src/soak/db.ts`'s own `soak.sqlite`, with no FK
 * relationship to Drover's `runs`/`sessions`/`action_events` lineage or
 * Grader's `grading_runs`/`cases`/`tasks` — same non-participation Grader
 * already established for itself.
 *
 * Vocabulary and every non-obvious shape decision below trace back to
 * CTS.md's resolved-decisions table and the referenced ADRs — read those
 * before changing any of these, same discipline CLAUDE.md applies to the
 * simulation stack's own key decisions.
 */

export type SoakDataPolicy = "synthetic-only" | "restricted";

export type SoakRunStatus = "running" | "completed" | "budget-stopped" | "crashed";

/**
 * Runtime knobs for the local driver's "lightly vary this example" step
 * (ADR 0009) — word substitution, length trim/pad, and detail reordering are
 * the three variation techniques ADR 0009 names explicitly. All optional: an
 * absent field means the driver's own built-in default for that dimension
 * (defined by Session 4's provider, not here).
 */
export interface VariationParams {
  /** Approximate fraction (0..1) of words the driver may substitute with a synonym/near-equivalent. */
  wordSubstitutionRate?: number;
  /** Character-length range the driver should trim or pad the varied text toward. */
  targetLengthChars?: { min: number; max: number };
  /** Whether the driver may reorder independent narrative details/sentences. */
  allowDetailReordering?: boolean;
}

/**
 * A named bucket of Claude-authored example narratives (ADR 0009) — the
 * local driver only selects and lightly varies one of `examples` at runtime;
 * it never authors new scenarios from scratch. `lane` says which of the
 * scheduler's two lanes (Session 3) draws from this pool: `"backbone"` for
 * the uncapped lane, or a metered pipeline's own name (which must match a
 * `PipelineBudget.pipeline` for the scheduler to find its budget) otherwise
 * — see the "Backbone traffic" glossary entry. More than one pool may share
 * a lane (e.g. several distinct backbone scenarios); the scheduler picks
 * among same-lane pools, not just among one pool's own examples.
 */
export interface VariationPool {
  /** Bucket name — referenced by `TurnRecord.variationId` once Session 3 assigns per-turn ids. */
  name: string;
  lane: "backbone" | string;
  /**
   * Path (resolved against `SoakBlueprint.targetBaseUrl`) this pool's turns
   * are dispatched to — added in Session 3 once real HTTP dispatch needed
   * somewhere concrete to send a request; Sessions 1-2's schema didn't yet
   * need it. The scheduler POSTs a fixed `{ text: <varied example> }` JSON
   * envelope (see `scheduler.ts`) — a deliberately fixed v1 wire shape, not
   * a pluggable request-builder; revisit if a real target's blueprint (built
   * in that target's own repo, per ADR 0010) needs a different body shape.
   */
  path: string;
  /** @default "POST" */
  method?: string;
  examples: string[];
  variation?: VariationParams;
}

/**
 * A metered pipeline's own explicit per-run call ceiling — distinct from the
 * backbone lane's `pacingMs`-based pacing (see "Backbone traffic"). Spread
 * across `SoakBlueprint.maxDurationHours` by the scheduler (Session 3), not
 * fired at `pacingMsRange` cadence, since uniform pacing across both lanes
 * would exhaust a real target's monthly usage caps within the first hour of
 * an unattended run.
 */
export interface PipelineBudget {
  /** Must match a VariationPool.lane for the scheduler to draw from. */
  pipeline: string;
  maxCallsPerRun: number;
}

/**
 * The hard-dollar ceiling on a soak run (CONTEXT.md Glossary: "SoakBudget"),
 * checked between turns with graceful shutdown — same load-bearing-knob
 * discipline `BudgetConfig`/`analystCeilingUsd`/`graderCeilingUsd` already
 * established elsewhere. This is the blueprint-authored config value; the
 * runtime running-total tracker (mirroring `SessionBudget`/`GraderBudget`)
 * is Session 3's job, not this session's.
 */
export interface SoakBudgetConfig {
  ceilingUsd: number;
  /**
   * Flat per-turn cost estimate (USD), used when a turn's response doesn't
   * report a real cost figure via the `x-soak-cost-usd` response header (see
   * `SOAK_COST_HEADER`, `scheduler.ts`) — needed for a toy/non-billed
   * fixture target to exercise the budget ceiling at all (CTS.md Session 3:
   * "tracked from real response cost where the target reports it, or a
   * configured per-call cost estimate"). Unset means $0 per turn when no
   * cost header is present — no artificial spend is invented.
   */
  costPerCallUsd?: number;
}

/**
 * Passed to `SoakBlueprint.teardown` — same timestamp-window-sweep contract
 * `DomainPackTeardownContext` already established for the simulation stack,
 * since the non-negotiable "staging teardown wipes everything a run created"
 * constraint applies here identically.
 */
export interface SoakTeardownContext {
  runId: string;
  targetBaseUrl: string;
  /** Raw epoch milliseconds — this run's own SoakRun.startedAt. */
  runStartedAt: number;
  /** Raw epoch milliseconds, taken right as the run finishes and teardown is invoked. */
  runEndedAt: number;
}

/**
 * The versioned, typed-TypeScript config a soak run is built from
 * (CONTEXT.md Glossary: "Blueprint") — loaded via the same `loadDefaultExport`
 * every other typed-TS config in this project already uses (Session 2's job,
 * not this one). `version` is a plain author-set tag (not derived or
 * validated here) so a run's stored `blueprintVersion` stays meaningful even
 * as the same blueprint file's content evolves over time — mirrors why
 * Grader snapshots a rubric's content hash rather than trusting a bare name
 * reference to stay stable.
 */
export interface SoakBlueprint {
  appName: string;
  version: string;
  targetBaseUrl: string;
  /**
   * Enforced, not advisory (Session 2's `assertSoakDataPolicyAllowed`):
   * `restricted` means the configured driver must be Ollama, full stop — no
   * bundled hosted-provider exception. Mirrors Grader's `dataPolicy`
   * asymmetry against the actor tier's own `restricted`-but-Anthropic's-fine
   * bundling, which Soak's guard deliberately does not carry over (see
   * CTS.md's "Notes for whoever picks up the Shenny-side session").
   */
  dataPolicy: SoakDataPolicy;
  /**
   * Which driver backend `driverModel` runs on, e.g. "ollama" — mirrors
   * `ModelRoute.provider`'s loose `string` typing rather than a locked
   * literal union, so a future second driver provider is a config change
   * here, not a type change. Added in Session 2 specifically so
   * `assertSoakDataPolicyAllowed` has a real value to check against; Session
   * 1's schema didn't yet need it since nothing consumed it.
   */
  driverProvider: string;
  /** Local driver model identifier, e.g. "llama3.1:8b" (Ollama). */
  driverModel: string;
  variationPools: VariationPool[];
  pipelineBudgets: PipelineBudget[];
  /** Randomized pacing range for backbone-lane turns, in milliseconds (CTS.md: 5-60s — slow enough to stay a soak test rather than overlap with Stampede's already-existing rapid-fire purpose). */
  pacingMsRange: { minMs: number; maxMs: number };
  budget: SoakBudgetConfig;
  maxDurationHours: number;
  teardown?: (ctx: SoakTeardownContext) => Promise<void>;
}

/**
 * Data-only snapshot of a SoakBlueprint, persisted onto its SoakRun —
 * `teardown` is a function and isn't serializable, so it's deliberately
 * excluded, mirroring `Run.config`'s/`GraderPackConfigSnapshot`'s role for
 * the other two subsystems.
 */
export type SoakBlueprintConfigSnapshot = Omit<SoakBlueprint, "teardown">;

/**
 * One top-level invocation of Soak mode against a SoakBlueprint. Its own
 * entity — no relation to Drover's `Run`/`runs` or Grader's
 * `GradingRun`/`grading_runs`.
 */
export interface SoakRun {
  id: string;
  appName: string;
  blueprintVersion: string;
  driverModel: string;
  targetBaseUrl: string;
  /**
   * Full snapshot of the resolved SoakBlueprint the run started with —
   * added alongside the literal `blueprintVersion` tag CTS.md's schema
   * names, mirroring `Run.config`'s/`GraderPackConfigSnapshot`'s precedent:
   * a later `drover soak report` (reads only the DB, per CTS.md Session 7)
   * needs to render the pacing range, pipeline budgets, and variation pool
   * names an already-finished run actually used, without re-opening the
   * blueprint file (which may have since changed, or may not even be on
   * disk in a report-only context).
   */
  blueprintConfig: SoakBlueprintConfigSnapshot;
  status: SoakRunStatus;
  budgetCeilingUsd: number;
  /** Running (while `status === "running"`) or final total spend in USD, tracked by Session 3's runtime budget tracker. */
  spentUsd: number;
  /** Raw epoch milliseconds. */
  startedAt: number;
  endedAt?: number;
}

/** Which of the scheduler's two lanes a turn belongs to (see "Backbone traffic") — `"backbone"` or a metered pipeline's own name. */
export type SoakTurnLane = "backbone" | string;

/**
 * One iteration of the soak loop (CONTEXT.md Glossary: "Turn") — the
 * soak-mode analogue of `ActionEvent`, but HTTP-shaped rather than
 * browser-action-shaped. An explicit error (`explicitError: true`,
 * `errorDetail` set) is itself a real result worth having, per CTS.md's own
 * original framing — it's logged here, never allowed to kill the run.
 */
export interface TurnRecord {
  id: string;
  runId: string;
  /** 1-based order within the run — the scheduler's own dispatch order, not a wall-clock derivation. */
  sequence: number;
  lane: SoakTurnLane;
  /** Which VariationPool.name + which of its examples was selected and varied for this turn (e.g. "entry-happy-path#3") — opaque to storage, meaningful to whichever scheduler/digest code produced/consumes it. */
  variationId: string;
  requestPayload: unknown;
  responsePayload?: unknown;
  responseTimeMs?: number;
  httpStatus?: number;
  /** A 402/429 the blueprint's target treats as correct gating is NOT an explicit error (ADR 0006) — only a genuinely unexpected non-2xx, a thrown exception, or a timeout sets this. */
  explicitError?: boolean;
  errorDetail?: string;
  /** Raw epoch milliseconds. */
  timestamp: number;
}

/**
 * One named numeric observation attached to a run (CTS.md Session 1: "metrics
 * (open-ended... server response times and load stats are the obvious first
 * columns, not an exhaustive list)"). A flexible name/value shape rather than
 * a fixed set of columns, deliberately: it lets Session 6's timing-anomaly
 * pass (reusing `src/stampede/metrics.ts`'s percentile math) and any future
 * metric get recorded without a schema migration each time — the same
 * open-endedness CTS.md's own framing asked for.
 */
export interface MetricRecord {
  id: string;
  runId: string;
  name: string;
  value: number;
  /** Raw epoch milliseconds. */
  recordedAt: number;
}
