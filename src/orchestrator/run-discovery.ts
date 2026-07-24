/**
 * The discovery-mode orchestrator (CONTEXT.md "Execution modes" / CLAUDE.md
 * Session 4): reads a domain pack + SimConfig, expands them into a
 * sequential schedule (src/orchestrator/schedule.ts), and drives one
 * persona-session at a time through Session 3's actor loop.
 *
 * Per-session isolation: a session that ends `hard-stopped` (the actor loop
 * itself gave up) or that throws outright (browser crash, unexpected error)
 * both just get logged and the batch continues — CONTEXT.md: "a blocked
 * session is itself valuable data, not a run-ending failure." Only an error
 * escaping the whole scheduling loop (e.g. a schedule referencing an unknown
 * goal id) marks the run `crashed`.
 *
 * Budget: the hard per-run ceiling is checked between sessions (never
 * mid-session — CONTEXT.md "graceful shutdown... never dies mid-write"),
 * aggregating each session's `computeCostUsd`-derived total.
 *
 * Teardown runs finally-style: after a completed, budget-stopped, or crashed
 * run alike (CONTEXT.md "Environment & safety").
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
import type { DomainPack, ModelRoute, Run, RunStatus, SimConfig } from "../types/index.js";
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
 * `runDiscovery` only ever implements the sequential path (CONTEXT.md
 * "Execution modes" / CLAUDE.md non-negotiable constraint) — a
 * `concurrencyCap` above 1 has no real concurrent implementation behind it
 * yet (see GAPS.md). Silently ignoring it would let a pack author believe
 * they got parallelism they didn't, so it's rejected outright instead.
 */
export class ConcurrencyNotImplementedError extends Error {
  constructor(cap: number) {
    super(
      `SimConfig.concurrencyCap is set to ${cap}, but concurrent execution is not implemented — ` +
        "runDiscovery only supports sequential execution (concurrencyCap must be 1 or unset). See GAPS.md.",
    );
    this.name = "ConcurrencyNotImplementedError";
  }
}

function assertConcurrencyCapSupported(concurrencyCap: number | undefined): void {
  if (concurrencyCap !== undefined && concurrencyCap > 1) {
    throw new ConcurrencyNotImplementedError(concurrencyCap);
  }
}

export async function runDiscovery(opts: RunDiscoveryOptions): Promise<RunDiscoveryResult> {
  const { db, domainPack, config } = opts;
  // Enforced once at config-load time, not per-session (BUILD-STATE.md S3 note for S4).
  assertDataPolicyAllowed(domainPack.dataPolicy, config.modelRouting.actor);
  assertConcurrencyCapSupported(config.concurrencyCap);

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

  try {
    for (const scheduled of schedule) {
      if (totalCostUsd >= config.budget.runCeilingUsd) {
        status = "budget-stopped";
        break;
      }

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
  } catch (err) {
    status = "crashed";
    crashError = err;
  } finally {
    if (domainPack.teardown) {
      try {
        await domainPack.teardown({ runId, targetBaseUrl: config.targetBaseUrl });
      } catch (teardownErr) {
        console.error(`[drover] teardown hook failed for run ${runId}:`, teardownErr);
      }
    }
    if (ownsBrowser) await browser.close();
  }

  let reconciliation: ReconciliationSummary = { new: 0, stillOpen: 0, resolved: 0 };
  try {
    reconciliation = reconcileRunFindings(db, runId, domainPack.appName);
  } catch (err) {
    console.error(`[drover] finding reconciliation failed for run ${runId}:`, err);
  }

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
