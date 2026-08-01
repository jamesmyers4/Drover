/**
 * Consensus Round dispatch and per-Check resolution (FUTUREPLAN.md Grader
 * Session 5). A Consensus Round is the set of Tasks belonging to one
 * multi-judge layer on one Case, plus resolution — resolution is per-Check,
 * not holistic (Q11): each Check where every judge agrees (per that Check's
 * own agreement rule — exact-match for boolean, `numericTolerance` for
 * numeric) settles immediately; each Check where they don't gets its own
 * scoped escalation Task, carrying the shared Case context plus every
 * disputing judge's value *and* reasoning, not just their scores. A Round
 * therefore fans out to a variable 0-to-N escalation Tasks (N = Check
 * count), never a fixed width.
 *
 * Dispatch is fully sequential (ADR 0004) — every judge and escalation call
 * below is awaited one at a time, never issued concurrently. Model-family
 * diversity across the round's judges is asserted up front
 * (`assertDistinctModelFamilies`, ADR 0003); every escalation dispatch is
 * gated twice — `assertEscalationDispatchAllowed` (the scheduler-level
 * `dataPolicy` defense-in-depth check, ADR 0002) and `GraderBudget`'s
 * per-dispatch running-total check (Session 5's own budget guard) — both
 * immediately before the call, since escalation is discovered dynamically
 * mid-run and a startup-only check would never see it.
 *
 * Deliberately does not compute a single collapsed pass/fail for the round:
 * the Consensus Round glossary entry is explicit that a round's result
 * "reports every Check's final verdict plus how many needed escalation...
 * never collapsed into one opaque pass/fail." Wiring a resolved round into a
 * scheduler-dispatched layer's own single Task/pass-fail bookkeeping is
 * Session 6's job (tying Layers 4-7 together), once a real multi-judge layer
 * exists to need it.
 *
 * **A judge/escalation provider throwing is treated as infrastructure noise,
 * categorically distinct from a guard refusing to proceed.** A provider call
 * (`judge.score()`, `escalationProvider.score()`) gets bounded retries with
 * backoff (`RunConsensusRoundOptions.maxDispatchAttempts`, default 3) before
 * the round gives up on it; only once every attempt is exhausted does the
 * round persist itself as `aborted-error` (`GraderDb.abortConsensusRound`)
 * and return that outcome — it does not throw, since this is a first-class,
 * expected-to-happen-sometimes outcome the caller shouldn't need exception
 * handling to discover (see `ConsensusRoundStatus`'s doc comment in
 * types.ts). Guard calls — `assertDistinctModelFamilies`,
 * `assertEscalationDispatchAllowed`, `GraderBudget.assertCanDispatch` — are
 * never retried and never softened into `aborted-error`: they signal a
 * deliberate stop (a misconfigured pack, a policy violation, a spent
 * budget), not a transient fault, and retrying or quietly bucketing them
 * alongside provider flakiness would hide a real problem rather than
 * surface it. This distinction matters for Q10's escalation-rate metric
 * specifically — conflating "the judges genuinely disagreed" with "a
 * provider call failed" would make that metric uninterpretable.
 */

import type { GraderBudget } from "./budget.js";
import { type GraderDb, newGraderId } from "./db.js";
import { checkPasses } from "./layers/judge-layer.js";
import type { GraderModelProvider, GraderScoreResult } from "./provider.js";
import { resolveRubric, snapshotRubric } from "./rubric.js";
import { assertDistinctModelFamilies, assertEscalationDispatchAllowed } from "./scheduler.js";
import type {
  Case,
  CheckDefinition,
  CheckResolution,
  ConsensusRound,
  GraderPack,
  LayerId,
  Rubric,
  Task,
} from "./types.js";

/** 1 initial attempt + 2 retries — "one or two retries" per Session 5's review resolution. */
export const DEFAULT_MAX_DISPATCH_ATTEMPTS = 3;
/** Linear backoff base — attempt 1's failure waits this long, attempt 2's waits double, etc. */
export const DEFAULT_RETRY_BACKOFF_BASE_MS = 200;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a single judge/escalation dispatch up to `maxAttempts` times
 * (inclusive of the first try), sleeping `DEFAULT_RETRY_BACKOFF_MS * attempt`
 * between failures. Rethrows the last error once attempts are exhausted —
 * the caller (`runConsensusRound`) is what decides that exhaustion means
 * "abort the round," not this generic helper, which knows nothing about
 * Consensus Rounds at all.
 */
async function dispatchWithRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await sleep(DEFAULT_RETRY_BACKOFF_BASE_MS * attempt);
    }
  }
  // Unreachable — the loop above always either returns or throws on its last iteration.
  throw new Error("dispatchWithRetry: exhausted attempts without returning or throwing");
}

export interface RunConsensusRoundOptions {
  db: GraderDb;
  pack: GraderPack;
  gradingCase: Case;
  layerId: LayerId;
  /** Prompt framing shared by every judge Task in this round (see prompt.ts). */
  framing: string;
  /** At least 2, each a distinct `modelFamily` (asserted, not assumed — ADR 0003). */
  judges: GraderModelProvider[];
  /** Adjudicates any Check the judges don't agree on. Required — a Round with no way to resolve disagreement can't fulfill its own contract. */
  escalationProvider: GraderModelProvider;
  /** Checked before every escalation dispatch; omit for an uncapped round. */
  budget?: GraderBudget;
  /** Max attempts (including the first) per judge/escalation dispatch before the round gives up on it and aborts. @default DEFAULT_MAX_DISPATCH_ATTEMPTS (3) */
  maxDispatchAttempts?: number;
  /** Injectable retry-backoff delay — tests supply a no-op to avoid real waits. @default a real setTimeout-based sleep */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for deterministic tests. @default Date.now */
  now?: () => number;
}

export interface RunConsensusRoundResult {
  consensusRoundId: string;
  /** Mirrors the persisted round's own terminal state — see `ConsensusRoundStatus`. */
  status: "resolved" | "aborted-error";
  /** One entry per Check the rubric declares, in rubric order, on `resolved`; whatever Checks were resolved before the failing dispatch (may be empty) on `aborted-error`. */
  checkResolutions: CheckResolution[];
  /** One Task per judge that actually completed, already persisted, in judge-dispatch order. */
  judgeTasks: Task[];
  /** One Task per Check that needed escalation and actually completed, already persisted, in rubric order. */
  escalationTasks: Task[];
  /** Set only when status is "aborted-error" — the underlying provider error's message after every retry was exhausted. */
  abortedReason?: string;
}

interface CheckVote {
  modelFamily: string;
  value: boolean | number;
  reasoning: string;
}

function votesForCheck(judgeTasks: Task[], checkName: string): CheckVote[] {
  return judgeTasks.map((task) => {
    const check = task.checks.find((c) => c.name === checkName);
    if (!check) {
      throw new Error(
        `Judge Task ${task.id} did not report a result for Check "${checkName}" — every judge ` +
          "is expected to score every Check in the dispatched rubric (the provider layer already " +
          "enforces this on a well-formed response).",
      );
    }
    return {
      modelFamily: task.modelFamily ?? "unknown",
      value: check.value,
      reasoning: check.reasoning,
    };
  });
}

/** Boolean: unanimous exact match. Numeric: every vote within the Check's own `numericTolerance` of the spread (max - min) — never a Round-wide tolerance (Q11). */
function checksAgree(def: CheckDefinition, votes: CheckVote[]): boolean {
  if (def.scoringType === "boolean") {
    return votes.every((v) => v.value === votes[0]?.value);
  }
  const numericVotes = votes.map((v) => v.value as number);
  const spread = Math.max(...numericVotes) - Math.min(...numericVotes);
  return spread <= def.numericTolerance;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** The single-check rubric an escalation call is scoped to — same Rubric shape, just one Check, so the provider's own response-shape enforcement applies unchanged. */
function singleCheckRubric(rubric: Rubric, def: CheckDefinition): Rubric {
  return { key: rubric.key, description: rubric.description, checks: [def] };
}

/** Embeds the shared Case context (via the normal input/output prompt) plus every disputing judge's value and reasoning for this one Check — what actually lets the adjudicator adjudicate rather than average or coin-flip (Q11). */
function buildEscalationFraming(checkName: string, votes: CheckVote[]): string {
  const voteLines = votes
    .map(
      (v) =>
        `  - Judge (model family "${v.modelFamily}") scored ${JSON.stringify(v.value)}: "${v.reasoning}"`,
    )
    .join("\n");
  return [
    "Independent judges scored this Check and did not agree closely enough to settle",
    "automatically. You are the tie-breaking adjudicator for this Check only — read every",
    "disputing judge's value and reasoning below, then give your own independent verdict based",
    "on the shared input/output.",
    "",
    `Disputed Check: "${checkName}"`,
    "Disputing judges' votes:",
    voteLines,
  ].join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dispatches one full Consensus Round for one Case: every judge's Task,
 * per-Check agreement, and any escalation Tasks disagreement requires.
 * Persists every judge/escalation Task and the round's own resolution
 * directly via `db` — same "write as you go" precedent `dispatchCaseTasks`
 * already established, rather than batching everything into one write at
 * the end. A judge/escalation Task already persisted before a later
 * dispatch in the same round fails is never rolled back — the round's own
 * terminal state (`resolved` or `aborted-error`) reflects what actually
 * happened, not a hypothetical all-or-nothing transaction.
 *
 * Guard violations (`assertDistinctModelFamilies`,
 * `assertEscalationDispatchAllowed`, `GraderBudget.assertCanDispatch`) are
 * left to propagate uncaught — see this module's header comment for why
 * these are deliberately not retried or converted into `aborted-error`.
 * Everything else (an unexpected error the escalation-response lookup can
 * raise, or any other genuine bug) also propagates; only a judge/escalation
 * *provider call* itself, after exhausting `maxDispatchAttempts`, resolves
 * into the `aborted-error` return path instead of a throw.
 */
export async function runConsensusRound(
  opts: RunConsensusRoundOptions,
): Promise<RunConsensusRoundResult> {
  const { db, pack, gradingCase, layerId, framing, judges, escalationProvider, budget } = opts;
  const now = opts.now ?? Date.now;
  const maxDispatchAttempts = opts.maxDispatchAttempts ?? DEFAULT_MAX_DISPATCH_ATTEMPTS;
  const sleep = opts.sleep ?? defaultSleep;

  assertDistinctModelFamilies(judges);

  const rubric = resolveRubric(pack, gradingCase.rubric);
  const rubricSnapshot = snapshotRubric(rubric);
  const defByName = new Map(rubric.checks.map((def) => [def.name, def]));

  const consensusRoundId = newGraderId();
  const consensusRound: ConsensusRound = {
    id: consensusRoundId,
    caseId: gradingCase.id,
    layerId,
    status: "pending",
    checkResolutions: [],
    createdAt: now(),
  };
  db.insertConsensusRound(consensusRound);

  // Declared before `abort` (which closes over all three) so a throw during
  // the judge-dispatch loop below can call `abort` safely — `escalationTasks`
  // in particular would otherwise still be in its temporal dead zone at that
  // point, since the judge loop runs before any escalation is ever attempted.
  const judgeTasks: Task[] = [];
  const escalationTasks: Task[] = [];
  const checkResolutions: CheckResolution[] = [];

  function abort(reason: string, resolutionsSoFar: CheckResolution[]): RunConsensusRoundResult {
    db.abortConsensusRound(consensusRoundId, resolutionsSoFar, reason, now());
    return {
      consensusRoundId,
      status: "aborted-error",
      checkResolutions: resolutionsSoFar,
      judgeTasks,
      escalationTasks,
      abortedReason: reason,
    };
  }

  for (const judge of judges) {
    const startedAt = now();
    let result: GraderScoreResult;
    try {
      result = await dispatchWithRetry(
        () =>
          judge.score({ input: gradingCase.input, output: gradingCase.output, rubric, framing }),
        maxDispatchAttempts,
        sleep,
      );
    } catch (err) {
      return abort(errorMessage(err), []);
    }
    const status = result.checks.every((check) => {
      const def = defByName.get(check.name);
      return def ? checkPasses(def, check.value) : true;
    })
      ? "pass"
      : "fail";
    const task: Task = {
      id: newGraderId(),
      caseId: gradingCase.id,
      layerId,
      consensusRoundId,
      status,
      modelFamily: judge.modelFamily,
      executionTarget: judge.executionTarget,
      rubricSnapshot,
      checks: result.checks,
      startedAt,
      endedAt: now(),
    };
    db.insertTask(task);
    judgeTasks.push(task);
  }

  for (const def of rubric.checks) {
    const votes = votesForCheck(judgeTasks, def.name);

    if (checksAgree(def, votes)) {
      const finalValue =
        def.scoringType === "boolean"
          ? votes[0]?.value
          : average(votes.map((v) => v.value as number));
      checkResolutions.push({
        name: def.name,
        outcome: "agreed",
        finalValue: finalValue as boolean | number,
      });
      continue;
    }

    assertEscalationDispatchAllowed(pack);
    budget?.assertCanDispatch();

    const startedAt = now();
    let escalationResult: GraderScoreResult;
    try {
      escalationResult = await dispatchWithRetry(
        () =>
          escalationProvider.score({
            input: gradingCase.input,
            output: gradingCase.output,
            rubric: singleCheckRubric(rubric, def),
            framing: buildEscalationFraming(def.name, votes),
          }),
        maxDispatchAttempts,
        sleep,
      );
    } catch (err) {
      return abort(errorMessage(err), checkResolutions);
    }
    budget?.record(escalationResult.usage.costUsd);

    const adjudicated = escalationResult.checks.find((c) => c.name === def.name);
    if (!adjudicated) {
      throw new Error(
        `Escalation call for Check "${def.name}" did not return a result for it — the provider ` +
          "layer should already guarantee this for a well-formed response.",
      );
    }

    const escalationTask: Task = {
      id: newGraderId(),
      caseId: gradingCase.id,
      layerId,
      consensusRoundId,
      status: checkPasses(def, adjudicated.value) ? "pass" : "fail",
      modelFamily: escalationProvider.modelFamily,
      executionTarget: escalationProvider.executionTarget,
      rubricSnapshot,
      checks: [adjudicated],
      startedAt,
      endedAt: now(),
    };
    db.insertTask(escalationTask);
    escalationTasks.push(escalationTask);

    checkResolutions.push({ name: def.name, outcome: "escalated", finalValue: adjudicated.value });
  }

  db.resolveConsensusRound(consensusRoundId, checkResolutions, now());

  return { consensusRoundId, status: "resolved", checkResolutions, judgeTasks, escalationTasks };
}
