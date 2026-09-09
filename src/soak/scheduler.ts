/**
 * Soak mode's execution loop core (CTS.md Soak Sessions 3-4) — the two-lane
 * scheduler, local-model text variation, HTTP dispatch, and the `runSoak`
 * entry point that ties them together. Every turn's example text is lightly
 * varied by a `SoakContentProvider` (`content-provider.ts`) before dispatch
 * (CTS.md Session 4; ADR 0009) — the driver only selects and varies, never
 * authors new content.
 *
 * Two lanes (ADR 0006/CONTEXT.md Glossary "Backbone traffic"):
 * - **backbone**: draws from `lane: "backbone"` pools, paced by a randomized
 *   delay within `pacingMsRange` between turns.
 * - **metered-pipeline**: one lane per `PipelineBudget`, draws from pools
 *   whose `lane` matches that pipeline's name, paced by spreading
 *   `maxCallsPerRun` evenly across `maxDurationHours` instead of
 *   `pacingMsRange` — uniform backbone-style pacing across a rate-limited
 *   surface would exhaust a real target's monthly usage caps within the
 *   first hour of an unattended run.
 *
 * Both lanes run concurrently (`Promise.all`) but dispatch one turn at a
 * time *within* themselves — there is never an in-flight turn to cancel
 * when the budget ceiling is crossed, only a "don't start the next one"
 * decision, which is what `SoakBudget.assertCanDispatch()` enforces.
 */

import { assertSoakDataPolicyAllowed, validateSoakBlueprint } from "./blueprint-validation.js";
import { SoakBudget } from "./budget.js";
import { createSoakContentProvider, type SoakContentProvider } from "./content-provider.js";
import { newSoakId, type SoakDb } from "./db.js";
import type {
  PipelineBudget,
  SoakBlueprint,
  SoakBlueprintConfigSnapshot,
  SoakRunStatus,
  SoakTeardownContext,
  VariationPool,
} from "./types.js";

/**
 * Response header a real, cost-reporting target may set to report a turn's
 * actual billed cost (e.g. Shenny's own AI-pipeline routes, once its own
 * blueprint wires this up) — read here if present; falls back to
 * `SoakBudgetConfig.costPerCallUsd` otherwise (CTS.md Session 3: "tracked
 * from real response cost where the target reports it, or a configured
 * per-call cost estimate"). Not a contract any target is required to
 * implement — a target that never sets it just always uses the configured
 * estimate (or $0, if that's unset too).
 */
export const SOAK_COST_HEADER = "x-soak-cost-usd";

/**
 * HTTP statuses a soak turn treats as expected gating, not an error (ADR
 * 0006 — same distinction Shenny's own k6 load-test scripts already draw
 * for `402`/`429` against a real, tiered/rate-limited AI pipeline).
 */
const GATING_HTTP_STATUSES: ReadonlySet<number> = new Set([402, 429]);

export interface RunSoakOptions {
  db: SoakDb;
  blueprint: SoakBlueprint;
  /**
   * Bearer token for HTTP dispatch, sent as `Authorization: Bearer <token>`
   * — never logged, never sent to the driver model (secrets stay in the
   * HTTP layer only, the same project-wide discipline every other tier
   * follows). The CLI reads this from an env var; tests supply one directly
   * or omit it entirely.
   */
  authToken?: string;
  /**
   * The local driver that lightly varies each turn's example text (CTS.md
   * Session 4) — injectable for tests (`ScriptedSoakContentProvider`);
   * defaults to a real `OllamaSoakContentProvider` built from the
   * blueprint's own `driverProvider`/`driverModel` (`createSoakContentProvider`).
   */
  contentProvider?: SoakContentProvider;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to a real `setTimeout`-backed delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests — defaults to `Date.now`. */
  now?: () => number;
  /** Injectable RNG in [0, 1) for tests — defaults to `Math.random`, mirrors `buildSchedule`'s own `rand` precedent. */
  random?: () => number;
}

export interface RunSoakResult {
  runId: string;
  status: SoakRunStatus;
  turnsDispatched: number;
  explicitErrorCount: number;
  gatedResponseCount: number;
  spentUsd: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickRandom<T>(items: T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pickRandom called with an empty array.");
  return item;
}

function randomInRange(minMs: number, maxMs: number, random: () => number): number {
  return minMs + random() * (maxMs - minMs);
}

function groupPoolsByLane(pools: VariationPool[]): Map<string, VariationPool[]> {
  const byLane = new Map<string, VariationPool[]>();
  for (const pool of pools) {
    const existing = byLane.get(pool.lane);
    if (existing) existing.push(pool);
    else byLane.set(pool.lane, [pool]);
  }
  return byLane;
}

/** `Omit<SoakBlueprint, "teardown">` for persistence — `teardown` is a function and isn't serializable. */
function buildBlueprintConfigSnapshot(blueprint: SoakBlueprint): SoakBlueprintConfigSnapshot {
  const { teardown: _teardown, ...snapshot } = blueprint;
  return snapshot;
}

interface LaneContext {
  db: SoakDb;
  blueprint: SoakBlueprint;
  runId: string;
  runStartedAt: number;
  maxDurationMs: number;
  budget: SoakBudget;
  contentProvider: SoakContentProvider;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  authToken: string | undefined;
  stopRequested: () => boolean;
  requestStop: () => void;
  sequence: { n: number };
  counts: { dispatched: number; explicitErrors: number; gatedResponses: number };
}

/**
 * Dispatches one turn: selects an example, lightly varies it via
 * `ctx.contentProvider` (CTS.md Session 4), then makes the HTTP request and
 * persists the resulting `TurnRecord` — never throws for a turn-level
 * failure (a real error, whether from variation or from HTTP dispatch, is
 * captured as `explicitError`/`errorDetail`, per CTS.md's own "an explicit
 * error is itself a real result worth having" framing). The one exception is
 * `assertSoakDataPolicyAllowed`'s guard, which is never caught here — a
 * policy violation is a structural misconfiguration, not a transient
 * per-call failure, so it propagates uncaught and crashes the run, mirroring
 * how Grader's own guard violations (`assertDistinctModelFamilies`,
 * `assertEscalationDispatchAllowed`, `GraderBudget.assertCanDispatch`) are
 * deliberately never folded into that tier's provider-retry-and-continue
 * treatment either.
 */
async function dispatchTurn(ctx: LaneContext, lane: string, pool: VariationPool): Promise<void> {
  const sequence = ++ctx.sequence.n;
  const exampleIndex = Math.floor(ctx.random() * pool.examples.length);
  const exampleText = pool.examples[exampleIndex];
  if (exampleText === undefined) {
    throw new Error(`variationPools "${pool.name}" has no examples.`);
  }
  const variationId = `${pool.name}#${exampleIndex}`;
  const timestamp = ctx.now();

  // Defense-in-depth re-check (ADR 0002's "one chokepoint isn't trusted
  // alone" precedent) — Session 2's `validateSoakBlueprint` already checked
  // this once at blueprint-load time; this re-checks the *actual*
  // constructed provider's own identity immediately before the call that
  // matters, catching a mismatch the static blueprint fields alone
  // wouldn't (e.g. a future `createSoakContentProvider` bug).
  assertSoakDataPolicyAllowed(ctx.blueprint.dataPolicy, ctx.contentProvider.provider);

  let text: string;
  try {
    const variation = await ctx.contentProvider.vary({
      exampleText,
      ...(pool.variation !== undefined && { variation: pool.variation }),
    });
    text = variation.variedText;
  } catch (err) {
    ctx.db.insertTurn({
      id: newSoakId(),
      runId: ctx.runId,
      sequence,
      lane,
      variationId,
      requestPayload: { text: exampleText },
      explicitError: true,
      errorDetail: `variation failed: ${err instanceof Error ? err.message : String(err)}`,
      timestamp,
    });
    ctx.counts.dispatched++;
    ctx.counts.explicitErrors++;
    return;
  }

  const requestPayload = { text };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ctx.authToken !== undefined) headers.authorization = `Bearer ${ctx.authToken}`;

  let responsePayload: unknown;
  let responseTimeMs: number | undefined;
  let httpStatus: number | undefined;
  let explicitError = false;
  let errorDetail: string | undefined;

  const startedAt = ctx.now();
  try {
    const url = new URL(pool.path, ctx.blueprint.targetBaseUrl).toString();
    const response = await ctx.fetchImpl(url, {
      method: pool.method ?? "POST",
      headers,
      body: JSON.stringify(requestPayload),
    });
    responseTimeMs = ctx.now() - startedAt;
    httpStatus = response.status;

    const costHeader = response.headers.get(SOAK_COST_HEADER);
    const parsedCost = costHeader !== null ? Number(costHeader) : Number.NaN;
    const turnCostUsd = Number.isFinite(parsedCost)
      ? parsedCost
      : (ctx.blueprint.budget.costPerCallUsd ?? 0);
    ctx.budget.record(turnCostUsd);

    const bodyText = await response.text().catch(() => undefined);
    if (bodyText !== undefined && bodyText.length > 0) {
      try {
        responsePayload = JSON.parse(bodyText);
      } catch {
        responsePayload = bodyText;
      }
    }

    if (GATING_HTTP_STATUSES.has(httpStatus)) {
      ctx.counts.gatedResponses++;
    } else if (httpStatus >= 400) {
      explicitError = true;
      errorDetail = `HTTP ${httpStatus}`;
      ctx.counts.explicitErrors++;
    }
  } catch (err) {
    responseTimeMs = ctx.now() - startedAt;
    explicitError = true;
    errorDetail = err instanceof Error ? err.message : String(err);
    ctx.counts.explicitErrors++;
  }

  ctx.db.insertTurn({
    id: newSoakId(),
    runId: ctx.runId,
    sequence,
    lane,
    variationId,
    requestPayload,
    ...(responsePayload !== undefined && { responsePayload }),
    ...(responseTimeMs !== undefined && { responseTimeMs }),
    ...(httpStatus !== undefined && { httpStatus }),
    explicitError,
    ...(errorDetail !== undefined && { errorDetail }),
    timestamp,
  });

  ctx.counts.dispatched++;
}

async function runBackboneLane(ctx: LaneContext, pools: VariationPool[]): Promise<void> {
  if (pools.length === 0) return;
  const { minMs, maxMs } = ctx.blueprint.pacingMsRange;

  while (!ctx.stopRequested() && ctx.now() - ctx.runStartedAt < ctx.maxDurationMs) {
    try {
      ctx.budget.assertCanDispatch();
    } catch {
      ctx.requestStop();
      return;
    }
    const pool = pickRandom(pools, ctx.random);
    await dispatchTurn(ctx, "backbone", pool);
    await ctx.sleep(randomInRange(minMs, maxMs, ctx.random));
  }
}

async function runPipelineLane(
  ctx: LaneContext,
  pipelineBudget: PipelineBudget,
  pools: VariationPool[],
): Promise<void> {
  if (pools.length === 0 || pipelineBudget.maxCallsPerRun === 0) return;
  const intervalMs = ctx.maxDurationMs / pipelineBudget.maxCallsPerRun;
  let dispatched = 0;

  while (
    !ctx.stopRequested() &&
    ctx.now() - ctx.runStartedAt < ctx.maxDurationMs &&
    dispatched < pipelineBudget.maxCallsPerRun
  ) {
    try {
      ctx.budget.assertCanDispatch();
    } catch {
      ctx.requestStop();
      return;
    }
    const pool = pickRandom(pools, ctx.random);
    await dispatchTurn(ctx, pipelineBudget.pipeline, pool);
    dispatched++;
    if (dispatched < pipelineBudget.maxCallsPerRun) {
      await ctx.sleep(intervalMs);
    }
  }
}

/**
 * Executes a full soak run end-to-end: validates the blueprint (never
 * inserts a `soak_runs` row for an invalid one, same precedent
 * `runGradingRun` established for Grader), dispatches both scheduler lanes
 * concurrently until `maxDurationHours` elapses or the budget ceiling is
 * crossed, runs `teardown` finally-style, then writes the final row. Throws
 * only for a genuine orchestration-level fault (mirrors `runDiscovery`'s own
 * `crashed`-is-rare contract) — a turn-level HTTP error never propagates
 * this far; it's captured on the turn itself instead.
 */
export async function runSoak(options: RunSoakOptions): Promise<RunSoakResult> {
  const { db, blueprint } = options;
  validateSoakBlueprint(blueprint);

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const contentProvider = options.contentProvider ?? createSoakContentProvider(blueprint);

  const runId = newSoakId();
  const runStartedAt = now();
  const budget = new SoakBudget(blueprint.budget.ceilingUsd);

  db.insertSoakRun({
    id: runId,
    appName: blueprint.appName,
    blueprintVersion: blueprint.version,
    driverModel: blueprint.driverModel,
    targetBaseUrl: blueprint.targetBaseUrl,
    blueprintConfig: buildBlueprintConfigSnapshot(blueprint),
    status: "running",
    budgetCeilingUsd: blueprint.budget.ceilingUsd,
    spentUsd: 0,
    startedAt: runStartedAt,
  });

  let stopped = false;
  const ctx: LaneContext = {
    db,
    blueprint,
    runId,
    runStartedAt,
    maxDurationMs: blueprint.maxDurationHours * 60 * 60 * 1000,
    budget,
    contentProvider,
    fetchImpl,
    sleep,
    now,
    random,
    authToken: options.authToken,
    stopRequested: () => stopped,
    requestStop: () => {
      stopped = true;
    },
    sequence: { n: 0 },
    counts: { dispatched: 0, explicitErrors: 0, gatedResponses: 0 },
  };

  const lanePools = groupPoolsByLane(blueprint.variationPools);
  const laneTasks: Promise<void>[] = [runBackboneLane(ctx, lanePools.get("backbone") ?? [])];
  for (const pipelineBudget of blueprint.pipelineBudgets) {
    laneTasks.push(
      runPipelineLane(ctx, pipelineBudget, lanePools.get(pipelineBudget.pipeline) ?? []),
    );
  }

  let crashError: unknown;
  try {
    await Promise.all(laneTasks);
  } catch (err) {
    crashError = err;
  }

  const endedAt = ctx.now();
  const status: SoakRunStatus = crashError ? "crashed" : stopped ? "budget-stopped" : "completed";

  if (blueprint.teardown) {
    try {
      await blueprint.teardown({
        runId,
        targetBaseUrl: blueprint.targetBaseUrl,
        runStartedAt,
        runEndedAt: endedAt,
      } satisfies SoakTeardownContext);
    } catch (teardownErr) {
      console.error(`[drover] soak teardown hook failed for run ${runId}:`, teardownErr);
    }
  }

  db.updateSoakRunSpend(runId, budget.spent);
  db.updateSoakRunStatus(runId, status, endedAt);

  if (crashError) throw crashError;

  return {
    runId,
    status,
    turnsDispatched: ctx.counts.dispatched,
    explicitErrorCount: ctx.counts.explicitErrors,
    gatedResponseCount: ctx.counts.gatedResponses,
    spentUsd: budget.spent,
  };
}
