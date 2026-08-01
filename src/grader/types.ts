/**
 * Grader — a separate subsystem, not a fourth tier (CONTEXT.md Glossary:
 * "Grader"; docs/adr/0001-grader-quorum-exception.md). Core types only.
 * Storage lives in `src/grader/db.ts`, its own `grader.sqlite`, with no FK
 * relationship to Drover's `runs`/`sessions`/`action_events` lineage.
 *
 * Vocabulary and every non-obvious shape decision below trace back to
 * FUTUREPLAN.md's resolved-decisions table and the referenced ADRs/Q-numbers
 * — read those before changing any of these, same discipline CLAUDE.md
 * applies to the simulation stack's own key decisions.
 */

export type LayerId = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type CheckScoringType = "boolean" | "numeric";

/**
 * One named, independently-scored criterion inside a rubric. Carries its own
 * agreement rule (exact-match for boolean, numeric tolerance for scored) —
 * per the Consensus Round glossary entry, a tolerance rule is meaningless or
 * wrong applied uniformly across different Check data types. A discriminated
 * union rather than an optional `numericTolerance` field so that rule is
 * structurally required wherever it's meaningful (Q11: every numeric Check
 * carries its own tolerance, not an implicit Round-wide default) and
 * structurally absent where it isn't (a boolean Check's rule is exact-match,
 * full stop — there is nothing for a tolerance field to mean).
 */
export interface BooleanCheckDefinition {
  name: string;
  description: string;
  scoringType: "boolean";
}

/**
 * How a numeric Check's resolved score converts to a single judge's own
 * pass/fail verdict — distinct from `numericTolerance`, which only governs
 * whether two judges' scores count as *agreement* with each other (Q11).
 * Neither field can stand in for the other: two judges scoring a
 * faithfulness Check "3/10" apiece agree perfectly (small `numericTolerance`
 * gap) while both clearly failing the Check on its merits — `passThreshold`
 * is what makes that failure visible instead of silently absorbed into a
 * boolean-only verdict. `comparison` carries an explicit direction because
 * "higher is better" doesn't hold for every metric (e.g. a hallucination-
 * rate Check wants `lte`, a quality-score Check wants `gte`).
 */
export interface NumericPassThreshold {
  comparison: "gte" | "lte";
  value: number;
}

export interface NumericCheckDefinition {
  name: string;
  description: string;
  scoringType: "numeric";
  /** Max allowed |a - b| between two judges' scores for this Check to count as agreement. */
  numericTolerance: number;
  /** The score a single judge's own verdict must satisfy to count as a pass for this Check — see `NumericPassThreshold`'s doc comment for why this is a separate concept from `numericTolerance`. */
  passThreshold: NumericPassThreshold;
}

export type CheckDefinition = BooleanCheckDefinition | NumericCheckDefinition;

export interface Rubric {
  key: string;
  description: string;
  checks: CheckDefinition[];
}

/**
 * A declared prerequisite: the owning layer is skipped when the referenced
 * layer's Task on the same Case is genuinely unmet. Declaring one *requires*
 * a justification string ("structurally meaningless without X," never
 * cost-flavored intuition) — Q5's guardrail against the always-run-
 * everything default quietly eroding under a friendlier name.
 */
export interface LayerPrerequisite {
  layerId: LayerId;
  justification: string;
}

export interface LayerOverride {
  enabled?: boolean;
  requires?: LayerPrerequisite[];
}

/**
 * Sparse override map keyed by layer id. An absent layer id runs at its
 * built-in default — never treated as disabled by omission (Q8's
 * omission-semantics fix).
 */
export type LayerConfig = Partial<Record<LayerId, LayerOverride>>;

/** One `{input, output, rubric}` triple as returned by `GraderPack.loadCases` — not yet persisted, has no id. */
export interface CaseInput {
  input: unknown;
  output: unknown;
  /** A key into `GraderPack.rubrics`, resolved to live rubric content at Task-dispatch time. */
  rubric: string;
}

/**
 * App-specific adapter for Grader — mirrors `DomainPack`'s role for the
 * simulation stack. Deliberately has no `teardown`/`auth`: Grader never
 * touches the target app (see the Grader glossary entry's pure-function
 * boundary — an adapter's `loadCases` is entirely responsible for producing
 * `{input, output, rubric}` triples, however it gets them).
 */
export interface GraderPack {
  appName: string;
  rubrics: Record<string, Rubric>;
  loadCases: () => Promise<CaseInput[]> | CaseInput[];
  layers?: LayerConfig;
  /**
   * `restricted` means local-only judges, full stop — unlike
   * `DomainPack.dataPolicy`, there is no bundled hosted-provider exception.
   * See docs/adr/0002-grader-datapolicy-fail-closed-escalation.md.
   */
  dataPolicy: "synthetic-only" | "restricted";
  /**
   * Separate, fail-closed flag (default false) — must be explicitly `true`
   * before any Task may dispatch to a hosted judge. Checked per Task
   * dispatch, not once at Grading Run start, since Consensus Round
   * escalation dispatches a new Task dynamically, mid-run (ADR 0002).
   */
  allowHostedEscalation?: boolean;
  /**
   * Optional hard dollar ceiling on the rare escalation path (Grader
   * Session 5's `budget.ts` — see FUTUREPLAN.md's cost-basis note: routine
   * Grader operation is $0 by design, so this bounds escalation Tasks only,
   * not a per-Grading-Run cost the way `BudgetConfig.runCeilingUsd` bounds
   * the simulation stack). Declared here now, unenforced until Session 5's
   * `budget.ts` does a running-total check per escalation dispatch — the
   * field exists from Session 1 so that check has something to compare
   * against without a later schema/type retrofit.
   */
  graderCeilingUsd?: number;
}

/** Data-only snapshot of a GraderPack, persisted onto its GradingRun — `loadCases` is a function and isn't serializable, so it's deliberately excluded (mirrors `Run.config`'s role for the simulation stack). */
export interface GraderPackConfigSnapshot {
  appName: string;
  rubrics: Record<string, Rubric>;
  layers?: LayerConfig;
  dataPolicy: "synthetic-only" | "restricted";
  allowHostedEscalation?: boolean;
  graderCeilingUsd?: number;
}

export type GradingRunStatus = "running" | "completed" | "budget-stopped" | "crashed";

/** One top-level invocation of Grader against a GraderPack-supplied dataset. Its own entity — no relation to Drover's `Run`/`runs` table. */
export interface GradingRun {
  id: string;
  appName: string;
  packConfig: GraderPackConfigSnapshot;
  status: GradingRunStatus;
  /** Raw epoch milliseconds. */
  startedAt: number;
  endedAt?: number;
}

/** A persisted Case — one `{input, output, rubric}` triple, the thing Grader ultimately produces a verdict for. */
export interface Case {
  id: string;
  gradingRunId: string;
  input: unknown;
  output: unknown;
  /**
   * The rubric key as supplied by the adapter. Resolved rubric *content* is
   * snapshotted onto each Task's own result (see `RubricSnapshot`), not
   * here, so a Case stays a stable reference point even if the pack's
   * rubric definitions change between when this Case was graded and when
   * someone reads it back later.
   */
  rubric: string;
  /** Raw epoch milliseconds. */
  createdAt: number;
}

export type TaskStatus = "pending" | "running" | "pass" | "fail" | "skipped";

/** One Check's result inside a Task's structured payload — reasoning persists alongside the score (Q11), never the score alone. */
export interface CheckResult {
  name: string;
  value: boolean | number;
  reasoning: string;
}

/**
 * Resolved rubric content and/or hash, snapshotted at Task-persistence time
 * (Q8) — keeps a Grading Run's results interpretable months later even if
 * the pack's rubric definitions have since changed. Absent for layers that
 * don't consume a named rubric at all (e.g. Layer 1's deterministic checks).
 */
export interface RubricSnapshot {
  key: string;
  contentHash: string;
  content: Rubric;
}

/**
 * The dispatch/execution unit: "run layer L against Case C," or, within a
 * Consensus Round, "get judge J's vote on Case C's layer L," or a scoped
 * escalation Task resolving one disputed Check. Not intrinsically an LLM
 * call — a deterministic-checks-layer Task is plain synchronous code with
 * no context to manage. See the Task glossary entry in CONTEXT.md.
 */
export interface Task {
  id: string;
  caseId: string;
  layerId: LayerId;
  /** Set only for Tasks belonging to a multi-judge layer's Consensus Round (judge Tasks and escalation Tasks) — absent for a plain single-pass layer Task. */
  consensusRoundId?: string;
  status: TaskStatus;
  /** LLM-backed Tasks only — family-level identity (ADR 0003): two quantizations of the same base model count as one family, not two. */
  modelFamily?: string;
  /**
   * LLM-backed Tasks only — which physical box/endpoint ran it. A
   * placement/scheduling property, deliberately distinct from
   * `modelFamily` (ADR 0004) so the future concurrency toggle ("one Task
   * per distinct executionTarget" dispatched simultaneously) is a config
   * change, not a rewrite. Recorded even under v1's fully-sequential
   * dispatch.
   */
  executionTarget?: string;
  rubricSnapshot?: RubricSnapshot;
  /** One Task/one call can score several Checks in a single pass — loading the Case's input/output is the expensive part, not asking one question vs. several. */
  checks: CheckResult[];
  /** Set when status is "skipped" — the unmet prerequisite's required justification string (Q5), copied from the LayerPrerequisite that caused the skip. */
  skippedReason?: string;
  /** Raw epoch milliseconds. */
  startedAt: number;
  endedAt?: number;
}

export type CheckConsensusOutcome = "agreed" | "escalated";

/** One Check's final resolution within a Consensus Round. */
export interface CheckResolution {
  name: string;
  outcome: CheckConsensusOutcome;
  /** The settled value — either the judges' agreed value, or the escalation Task's adjudicated one. */
  finalValue: boolean | number;
}

/**
 * A round's own top-level lifecycle state — distinct from a Check's
 * per-resolution `CheckConsensusOutcome` (`agreed`/`escalated`). `pending` is
 * the state between `insertConsensusRound` and whichever terminal state the
 * round reaches; under v1's synchronous, sequential dispatch it should only
 * ever be observed if the process is killed mid-round (an OOM, a hard
 * process kill) before either terminal write lands — the same relationship
 * `GradingRunStatus`'s `running` has to `completed`/`crashed`.
 *
 * `aborted-error` (Session 5) is a genuinely distinct third terminal state,
 * not a shade of `resolved` or an absence of it — added for the same reason
 * Q5 made `skipped` a first-class `TaskStatus` value rather than letting a
 * report infer it from missing data: collapsing "a judge/escalation
 * provider call failed even after retries" into "not yet resolved" would
 * make an aborted round indistinguishable from one that's still legitimately
 * in flight, and collapsing it into "resolved" (with empty/partial
 * `checkResolutions`) would misrepresent a coverage gap as a real verdict.
 * Set only when every retry (`RunConsensusRoundOptions.maxDispatchAttempts`)
 * of a judge or escalation dispatch has been exhausted — never for a guard
 * violation (`assertDistinctModelFamilies`, `assertEscalationDispatchAllowed`,
 * `GraderBudget.assertCanDispatch`), which are deliberate, non-retriable
 * stops that must keep throwing loudly rather than being softened into this
 * bucket.
 */
export type ConsensusRoundStatus = "pending" | "resolved" | "aborted-error";

/**
 * The set of Tasks belonging to one multi-judge layer on one Case, plus
 * resolution. Resolution is per-Check, not holistic (Q11): each Check where
 * all judges agree (per that Check's own agreement rule) settles
 * immediately; each Check where they don't gets its own scoped escalation
 * Task. A real table storing the resolved outcome per Check — not a
 * computed grouping recomputed from raw votes on every read.
 */
export interface ConsensusRound {
  id: string;
  caseId: string;
  layerId: LayerId;
  status: ConsensusRoundStatus;
  /** Whatever Checks were actually resolved before the round reached a terminal state — empty on a fresh `pending` round, partial on an `aborted-error` one (the Checks resolved before the failing dispatch), complete on `resolved`. */
  checkResolutions: CheckResolution[];
  /** Raw epoch milliseconds. */
  createdAt: number;
  /** Set only when status is "resolved" — every Check in the round has a final resolution. */
  resolvedAt?: number;
  /**
   * Set only when status is "aborted-error" — the underlying judge/
   * escalation provider error's message, after every retry attempt was
   * exhausted. Infrastructure noise, not a quality signal: this is what
   * keeps a report's escalation-rate metric (Q10) interpretable, since a
   * flaky provider call and a genuine judge disagreement are categorically
   * different reasons a Check might not have a clean "agreed" resolution.
   */
  abortedReason?: string;
  /** Raw epoch milliseconds — set only when status is "aborted-error". */
  abortedAt?: number;
}
