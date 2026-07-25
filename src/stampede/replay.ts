/**
 * The scripted replay engine: no LLM, no reasoning, no decision loop — just
 * timed navigations at a given concurrency level (CONTEXT.md: "same
 * underlying harness, different runner"). Reuses `src/browser/`'s
 * `launchBrowser`/device presets for consistency with the actor tier, but
 * deliberately does *not* route through `BrowserSession` itself: that
 * class's primitives write one `action_events` row per call (with a
 * `sessions` FK), which is the wrong shape for a load test's data (no
 * persona, no goal, potentially thousands of requests per concurrency
 * level) and would bloat the discovery event log it has nothing to do with.
 */

import type { Browser, Page } from "playwright";
import { contextOptionsForDevice, type DeviceType } from "../browser/index.js";
import type { ReplaySample } from "./metrics.js";

export interface ConcurrencyLevelOptions {
  browser: Browser;
  targetBaseUrl: string;
  routes: string[];
  concurrency: number;
  /** Full passes through `routes` each concurrent worker makes. */
  iterationsPerWorker: number;
  deviceType: DeviceType;
  navigationTimeoutMs: number;
}

async function timedNavigate(
  page: Page,
  targetBaseUrl: string,
  route: string,
  concurrency: number,
): Promise<ReplaySample> {
  const url = new URL(route, targetBaseUrl).toString();
  const start = Date.now();
  try {
    const response = await page.goto(url);
    const durationMs = Date.now() - start;
    const ok = response !== null && response.status() < 400;
    return { route, concurrency, durationMs, ok };
  } catch {
    // Navigation timeout, connection refused, etc. — a real "error under load" data point.
    return { route, concurrency, durationMs: Date.now() - start, ok: false };
  }
}

async function runOneWorker(opts: ConcurrencyLevelOptions): Promise<ReplaySample[]> {
  const context = await opts.browser.newContext(contextOptionsForDevice(opts.deviceType));
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(opts.navigationTimeoutMs);

  const samples: ReplaySample[] = [];
  try {
    for (let pass = 0; pass < opts.iterationsPerWorker; pass++) {
      for (const route of opts.routes) {
        samples.push(await timedNavigate(page, opts.targetBaseUrl, route, opts.concurrency));
      }
    }
  } finally {
    await context.close();
  }
  return samples;
}

/** Runs `opts.concurrency` independent workers in parallel, each in its own isolated browser context. */
export async function runConcurrencyLevel(opts: ConcurrencyLevelOptions): Promise<ReplaySample[]> {
  const workers = Array.from({ length: opts.concurrency }, () => runOneWorker(opts));
  const results = await Promise.all(workers);
  return results.flat();
}
