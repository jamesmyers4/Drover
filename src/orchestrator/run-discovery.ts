/**
 * The discovery-mode orchestrator (CONTEXT.md "Execution modes" / CLAUDE.md
 * Session 4): reads a domain pack + SimConfig, expands them into a schedule
 * (src/orchestrator/schedule.ts), and drives persona-sessions through
 * Session 3's actor loop — sequentially by default, or through a bounded
 * worker pool when `SimConfig.concurrencyCap` is set above 1 (GAPS fix:
 * `concurrencyCap > 1` used to be rejected outright with
 * `ConcurrencyNotImplementedError`; this is the real implementation CLAUDE.md
 * said had to exist before that guard could be relaxed). A `concurrencyCap`
 * of 1 (or unset) still runs exactly one worker, which is just the original
 * sequential loop — no behavior change for the default path.
 *
 * Per-session isolation: a session that ends `hard-stopped` (the actor loop
 * itself gave up) or that throws outright (browser crash, unexpected error)
 * both just get logged and the batch continues — CONTEXT.md: "a blocked
 * session is itself valuable data, not a run-ending failure." Only an error
 * escaping the schedule lookup itself (e.g. a schedule referencing an
 * unknown goal id — a config bug, not a runtime persona failure) marks the
 * run `crashed`; every worker stops pulling new work once this happens, but
 * sessions already in flight are allowed to finish first.
 *
 * Budget: the hard per-run ceiling is checked before each worker launches
 * its *next* session, not mid-session (CONTEXT.md "graceful shutdown...
 * never dies mid-write"). With `concurrencyCap` above 1 this is a
 * best-effort ceiling, not an exact one: up to `concurrencyCap - 1` other
 * sessions can already be in flight (and add their own cost) by the time one
 * worker notices the ceiling was crossed and stops launching new work — the
 * same trade-off any concurrent rate limiter makes. `concurrencyCap` 1
 * preserves the old exact-ceiling behavior, since there's only ever one
 * session in flight to begin with.
 *
 * Teardown runs finally-style: after a completed, budget-stopped, or crashed
 * run alike (CONTEXT.md "Environment & safety"). It's passed `runStartedAt`/
 * `runEndedAt` (GAPS.md's S4 entry) so a pack author can sweep-by-timestamp-
 * window without needing their own SQLite access — `runEndedAt` is `Date.now()`
 * taken right here, since the DB row's own `endedAt` isn't written until after
 * teardown returns (reconciliation and the final status update both still
 * need to run first).
 */

import type { Browser } from "playwright";
import { SessionBudget } from "../actor/budget.js";
import { runPersonaSession } from "../actor/loop.js";
import {
  assertDataPolicyAllowed,
  createModelProvider,
  type ModelProvider,
} from "../actor/provider.js";
import { BrowserSession, launchBrowser } from "../browser/index.js";
import { type DroverDb, newId } from "../db/database.js";
import { createTreelineAdapter, type TreelineAdapter } from "../treeline/adapter.js";
import type {
  CheckpointContextEntry,
  DomainPack,
  ModelRoute,
  Run,
  RunStatus,
  SimConfig,
} from "../types/index.js";
import { type ReconciliationSummary, reconcileRunFindings } from "./reconcile.js";
import { buildSchedule, type ScheduledSession } from "./schedule.js";

export interface RunDiscoveryOptions {
  db: DroverDb;
  domainPack: DomainPack;
  config: SimConfig;
  screenshotDir: string;
  /** Reused across every session if supplied; otherwise launched and closed here. */
  browser?: Browser;
  treelineAdapter?: TreelineAdapter;
  /** Defaults to createModelProvider(route) — tests inject a ScriptedModelProvider per session. */
  providerFactory?: (route: ModelRoute, scheduled: ScheduledSession) => ModelProvider;
  /** Weighted-goal draw RNG — tests supply a deterministic one. @default Math.random */
  random?: () => number;
  /** Skip patience-derived pacing delays — used in tests. @default false */
  disablePacing?: boolean;
}

export interface RunDiscoveryResult {
  runId: string;
  status: RunStatus;
  sessionsScheduled: number;
  sessionsCompleted: number;
  sessionsHardStopped: number;
  sessionsBudgetCapped: number;
  sessionsErrored: number;
  totalCostUsd: number;
  reconciliation: ReconciliationSummary;
}

/**
 * `concurrencyCap` must be a positive integer when set — anything else (0,
 * negative, fractional, NaN) can't map to a worker count and would either
 * spin up zero workers (a run that schedules nothing and silently
 * "completes") or be nonsensical, so it's rejected before the run row is
 * written, same timing/pattern as `assertDataPolicyAllowed`.
 */
export class InvalidConcurrencyCapError extends Error {
  constructor(cap: number) {
    super(
      `SimConfig.concurrencyCap is set to ${cap}, but it must be a positive integer (1 or unset for the default sequential path).`,
    );
    this.name = "InvalidConcurrencyCapError";
  }
}

function assertConcurrencyCapValid(concurrencyCap: number | undefined): void {
  if (concurrencyCap !== undefined && (!Number.isInteger(concurrencyCap) || concurrencyCap < 1)) {
    throw new InvalidConcurrencyCapError(concurrencyCap);
  }
}

/**
 * Snapshots every checkpoint id's originating goal + description from the
 * domain pack, so the analyst tier (`src/analyst/prompt.ts`) can show
 * something more useful than a bare checkpoint id string (GAPS.md). Taken at
 * run-creation time, not looked up live from the pack at `drover analyze`
 * time, since a pack file can change or move between the two commands.
 */
export function buildCheckpointContext(
  domainPack: DomainPack,
): Record<string, CheckpointContextEntry> {
  const context: Record<string, CheckpointContextEntry> = {};
  for (const goal of domainPack.goals) {
    for (const checkpoint of goal.checkpoints) {
      context[checkpoint.id] = { goalId: goal.id, description: checkpoint.description };
    }
  }
  return context;
}

export async function runDiscovery(opts: RunDiscoveryOptions): Promise<RunDiscoveryResult> {
  const { db, domainPack, config } = opts;
  // Enforced once at config-load time, not per-session (SESSION-LOG.md's Session 3 note for Session 4).
  assertDataPolicyAllowed(domainPack.dataPolicy, config.modelRouting.actor);
  assertConcurrencyCapValid(config.concurrencyCap);
  const concurrencyCap = config.concurrencyCap ?? 1;

  const goalsById = new Map(domainPack.goals.map((g) => [g.id, g]));
  const personasById = new Map(domainPack.personas.map((p) => [p.id, p]));
  const schedule = buildSchedule(domainPack, config.runDimensions, opts.random ?? Math.random);

  const runId = newId();
  const run: Run = {
    id: runId,
    appName: domainPack.appName,
    config,
    status: "running",
    startedAt: Date.now(),
    checkpointContext: buildCheckpointContext(domainPack),
  };
  db.insertRun(run);

  const providerFactory =
    opts.providerFactory ?? ((route: ModelRoute) => createModelProvider(route));
  const treelineAdapter = opts.treelineAdapter ?? (await createTreelineAdapter());
  const ownsBrowser = !opts.browser;
  const browser = opts.browser ?? (await launchBrowser());

  let totalCostUsd = 0;
  let sessionsCompleted = 0;
  let sessionsHardStopped = 0;
  let sessionsBudgetCapped = 0;
  let sessionsErrored = 0;
  let sessionsScheduled = 0;
  let status: RunStatus = "completed";
  let crashError: unknown;

  // Runs exactly one scheduled session end to end. Throws only for a
  // schedule/config bug (unknown persona or goal id) — every other failure
  // mode (browser crash, actor loop exception) is caught here and recorded
  // as a per-session hard-stop, never propagated, so one worker's bad
  // session never takes down the others (CONTEXT.md "Environment & safety").
  async function runOneScheduledSession(scheduled: ScheduledSession): Promise<void> {
    const archetype = personasById.get(scheduled.archetypeId);
    const goal = goalsById.get(scheduled.goalId);
    if (!archetype || !goal) {
      throw new Error(
        `Scheduled session references unknown persona "${scheduled.archetypeId}" or goal "${scheduled.goalId}".`,
      );
    }

    sessionsScheduled++;
    const sessionId = newId();
    db.insertSession({
      id: sessionId,
      runId,
      personaId: archetype.id,
      goalId: goal.id,
      status: "running",
      startedAt: Date.now(),
    });

    let browserSession: BrowserSession | undefined;
    try {
      browserSession = await BrowserSession.open(browser, {
        sessionId,
        db,
        deviceType: archetype.traits.deviceType,
      });
      await browserSession.navigate(
        config.targetBaseUrl,
        `Starting a session as ${archetype.name}.`,
      );

      const provider = providerFactory(config.modelRouting.actor, scheduled);
      const budget = new SessionBudget(config.budget.perSessionSoftCapUsd);
      const result = await runPersonaSession({
        db,
        browserSession,
        browser,
        sessionId,
        provider,
        archetype,
        domainPack,
        goal,
        treelineAdapter,
        targetBaseUrl: config.targetBaseUrl,
        budget,
        screenshotDir: opts.screenshotDir,
        ...(opts.disablePacing !== undefined && { disablePacing: opts.disablePacing }),
      });

      db.updateSessionStatus(sessionId, result.status, Date.now());
      totalCostUsd += result.totalCostUsd;
      if (result.status === "completed") sessionsCompleted++;
      else if (result.status === "hard-stopped") sessionsHardStopped++;
      else if (result.status === "budget-capped") sessionsBudgetCapped++;
    } catch {
      // Per-session isolation: an exception here (browser crash, etc.) is
      // itself the "blocking bug" data point — log and move to the next
      // scheduled session rather than ending the whole run.
      sessionsErrored++;
      db.updateSessionStatus(sessionId, "hard-stopped", Date.now());
    } finally {
      await browserSession?.close();
    }
  }

  try {
    // A bounded worker pool over `schedule`, in schedule order: each worker
    // repeatedly claims the next unclaimed entry and runs it. `nextIndex`,
    // `stopLaunching`, and the counters above are only ever mutated in
    // synchronous stretches between `await`s, so plain closures over them
    // are safe here — Node never preempts mid-synchronous-block, even
    // though several workers' async functions are interleaved. With
    // `concurrencyCap` 1 (the default) this is exactly one worker pulling
    // one entry at a time — the original sequential loop, just reshaped.
    let nextIndex = 0;
    let stopLaunching = false;

    async function worker(): Promise<void> {
      while (!stopLaunching) {
        // Checked in this order so an empty (or fully-claimed) schedule
        // never trips "budget-stopped" — that status means "the schedule
        // was cut short," not "spend happened to be at or above the
        // ceiling when there was nothing left to do anyway."
        if (nextIndex >= schedule.length) break;
        if (totalCostUsd >= config.budget.runCeilingUsd) {
          status = "budget-stopped";
          stopLaunching = true;
          break;
        }
        const scheduled = schedule[nextIndex++];
        if (!scheduled) continue;

        try {
          await runOneScheduledSession(scheduled);
        } catch (err) {
          // A schedule/config bug crashes the whole run — stop every worker
          // from claiming further work, then let it propagate to the outer
          // catch once all workers have wound down (below).
          stopLaunching = true;
          throw err;
        }
      }
    }

    const workerCount = Math.max(1, Math.min(concurrencyCap, schedule.length));
    const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    const firstRejection = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (firstRejection) throw firstRejection.reason;
  } catch (err) {
    status = "crashed";
    crashError = err;
  } finally {
    if (domainPack.teardown) {
      try {
        await domainPack.teardown({
          runId,
          targetBaseUrl: config.targetBaseUrl,
          runStartedAt: run.startedAt,
          runEndedAt: Date.now(),
        });
      } catch (teardownErr) {
        console.error(`[drover] teardown hook failed for run ${runId}:`, teardownErr);
      }
    }
    if (ownsBrowser) await browser.close();
  }

  let reconciliation: ReconciliationSummary = { new: 0, stillOpen: 0, resolved: 0 };
  try {
    reconciliation = reconcileRunFindings(db, runId, domainPack.appName, {
      crossSessionDataComplete: false,
    });
  } catch (err) {
    console.error(`[drover] finding reconciliation failed for run ${runId}:`, err);
  }

  db.updateRunActorCost(runId, totalCostUsd);
  db.updateRunStatus(runId, status, Date.now());

  if (crashError) throw crashError;

  return {
    runId,
    status,
    sessionsScheduled,
    sessionsCompleted,
    sessionsHardStopped,
    sessionsBudgetCapped,
    sessionsErrored,
    totalCostUsd,
    reconciliation,
  };
}
