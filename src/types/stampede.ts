/**
 * Stampede mode's own records (CONTEXT.md "Execution modes": scripted,
 * non-reasoning replay of discovery-mode's discovered routes at volume).
 * Deliberately separate from `runs`/`sessions`/`action_events` — a stampede
 * run has no persona, no goal, and no single-action reasoning trace; its
 * data shape is aggregated response-time percentiles and error rates per
 * route per concurrency level, not a raw per-action event log.
 */

export interface StampedeRun {
  id: string;
  /** The discovery Run whose recorded `navigate` events supplied the routes, if any. */
  sourceRunId?: string;
  /** Always the source run's own `targetBaseUrl` — Stampede never accepts an arbitrary target. */
  targetBaseUrl: string;
  /** Concurrency levels tested, in the order they were run. */
  concurrencyLevels: number[];
  /** Raw epoch milliseconds. */
  startedAt: number;
  endedAt?: number;
}

/** One row per (route, concurrency level) tested in a stampede run. */
export interface StampedeRouteResult {
  id: string;
  stampedeRunId: string;
  route: string;
  concurrency: number;
  sampleCount: number;
  errorCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** Raw epoch milliseconds. */
  recordedAt: number;
}
