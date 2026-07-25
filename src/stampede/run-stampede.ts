/**
 * Stampede mode's entry point (CONTEXT.md "Execution modes"; CLAUDE.md
 * Session 7): a distinct CLI command from `drover run`/`analyze`/`report`.
 * No LLM calls anywhere in this tier — no actor-tier `dataPolicy`/budget
 * concerns apply, since there's no per-token cost and no model to route.
 * The only real safety concern is not hammering a dev-tier staging server
 * harder than intended, which is why `targetBaseUrl` is always taken from
 * the source discovery run's own stored config rather than an arbitrary
 * `--target` flag — Stampede can't be pointed anywhere the discovery run
 * wasn't already validated against.
 *
 * Runs each configured concurrency level to completion (own browser
 * contexts, own samples) before starting the next, so "how these numbers
 * degrade as concurrency climbs" is a clean before/after comparison rather
 * than several levels' traffic overlapping and confounding each other.
 */

import type { Browser } from "playwright";
import type { DeviceType } from "../browser/index.js";
import { launchBrowser } from "../browser/index.js";
import { type DroverDb, newId } from "../db/database.js";
import { type RouteSummary, summarizeSamples } from "./metrics.js";
import { runConcurrencyLevel } from "./replay.js";
import { extractDiscoveredRoutes, SourceRunNotFoundError } from "./routes.js";

export { NoRoutesDiscoveredError, SourceRunNotFoundError } from "./routes.js";

export const DEFAULT_CONCURRENCY_LEVELS = [1, 5, 10];
export const DEFAULT_ITERATIONS_PER_WORKER = 3;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;

export class InvalidStampedeOptionsError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidStampedeOptionsError";
  }
}

export interface RunStampedeOptions {
  db: DroverDb;
  /** Discovery run to pull routes + targetBaseUrl from. Mutually exclusive with `routes`. */
  sourceRunId?: string;
  /** Explicit route list, bypassing extraction from a discovery run — mainly for tests/programmatic use. */
  routes?: string[];
  /** Required (and only used) when `routes` is supplied directly. */
  targetBaseUrl?: string;
  /** @default [1, 5, 10] */
  concurrencyLevels?: number[];
  /** Full route-list passes each concurrent worker makes per level. @default 3 */
  iterationsPerWorker?: number;
  /** @default "desktop" */
  deviceType?: DeviceType;
  /** @default 15000 */
  navigationTimeoutMs?: number;
  /** Reused across every level if supplied; otherwise launched and closed here. */
  browser?: Browser;
}

export interface RunStampedeResult {
  stampedeRunId: string;
  sourceRunId?: string;
  targetBaseUrl: string;
  routes: string[];
  concurrencyLevels: number[];
  /** Every (route, concurrency) summary across every level tested, route-then-concurrency sorted. */
  results: RouteSummary[];
}

export async function runStampede(opts: RunStampedeOptions): Promise<RunStampedeResult> {
  const { db } = opts;
  const hasSourceRun = opts.sourceRunId !== undefined;
  const hasExplicitRoutes = opts.routes !== undefined;
  if (hasSourceRun === hasExplicitRoutes) {
    throw new InvalidStampedeOptionsError(
      "runStampede requires exactly one of `sourceRunId` or `routes`.",
    );
  }
  if (hasExplicitRoutes && opts.targetBaseUrl === undefined) {
    throw new InvalidStampedeOptionsError(
      "runStampede requires `targetBaseUrl` when `routes` is supplied directly.",
    );
  }

  let routes: string[];
  let targetBaseUrl: string;
  if (opts.sourceRunId !== undefined) {
    const sourceRun = db.getRun(opts.sourceRunId);
    if (!sourceRun) throw new SourceRunNotFoundError(opts.sourceRunId);
    routes = extractDiscoveredRoutes(db, opts.sourceRunId);
    targetBaseUrl = sourceRun.config.targetBaseUrl;
  } else {
    routes = opts.routes as string[];
    targetBaseUrl = opts.targetBaseUrl as string;
  }

  const concurrencyLevels = opts.concurrencyLevels ?? DEFAULT_CONCURRENCY_LEVELS;
  const iterationsPerWorker = opts.iterationsPerWorker ?? DEFAULT_ITERATIONS_PER_WORKER;
  const deviceType = opts.deviceType ?? "desktop";
  const navigationTimeoutMs = opts.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

  const stampedeRunId = newId();
  db.insertStampedeRun({
    id: stampedeRunId,
    ...(opts.sourceRunId !== undefined && { sourceRunId: opts.sourceRunId }),
    targetBaseUrl,
    concurrencyLevels,
    startedAt: Date.now(),
  });

  const ownsBrowser = !opts.browser;
  const browser = opts.browser ?? (await launchBrowser());

  const allResults: RouteSummary[] = [];
  try {
    for (const concurrency of concurrencyLevels) {
      const samples = await runConcurrencyLevel({
        browser,
        targetBaseUrl,
        routes,
        concurrency,
        iterationsPerWorker,
        deviceType,
        navigationTimeoutMs,
      });
      const recordedAt = Date.now();
      for (const summary of summarizeSamples(samples)) {
        db.insertStampedeRouteResult({ id: newId(), stampedeRunId, recordedAt, ...summary });
        allResults.push(summary);
      }
    }
  } finally {
    if (ownsBrowser) await browser.close();
    db.updateStampedeRunEnded(stampedeRunId, Date.now());
  }

  return {
    stampedeRunId,
    ...(opts.sourceRunId !== undefined && { sourceRunId: opts.sourceRunId }),
    targetBaseUrl,
    routes,
    concurrencyLevels,
    results: allResults.sort(
      (a, b) => a.route.localeCompare(b.route) || a.concurrency - b.concurrency,
    ),
  };
}
