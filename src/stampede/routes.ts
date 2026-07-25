/**
 * Pulls the set of routes to replay from a completed discovery run
 * (CONTEXT.md: Stampede "takes the actual routes/checkpoints discovery mode
 * already found"). Only `navigate` actions count as a "route" — `click`/
 * `fill` targets are CSS selectors, not URLs, and CONTEXT.md's framing
 * ("response time percentiles... per route") is about page-load
 * performance, not replaying a full goal's click/fill sequence (which
 * would mutate app data at load-test volume with no teardown correlation
 * to clean it up afterward — see GAPS.md).
 */

import type { DroverDb } from "../db/database.js";
import { normalizeRoute } from "../matching/match-key.js";

export class SourceRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`No run found with id "${runId}" to extract stampede routes from.`);
    this.name = "SourceRunNotFoundError";
  }
}

export class NoRoutesDiscoveredError extends Error {
  constructor(runId: string) {
    super(
      `Run "${runId}" has no recorded "navigate" events — nothing to replay. Run \`drover run\` first.`,
    );
    this.name = "NoRoutesDiscoveredError";
  }
}

/** Distinct normalized routes navigated to anywhere in the run, sorted for deterministic output. */
export function extractDiscoveredRoutes(db: DroverDb, sourceRunId: string): string[] {
  const run = db.getRun(sourceRunId);
  if (!run) throw new SourceRunNotFoundError(sourceRunId);

  const routes = new Set<string>();
  for (const session of db.getSessionsByRun(sourceRunId)) {
    for (const event of db.getEventsBySession(session.id)) {
      if (event.actionType !== "navigate") continue;
      routes.add(normalizeRoute(event.target));
    }
  }

  if (routes.size === 0) throw new NoRoutesDiscoveredError(sourceRunId);
  return Array.from(routes).sort();
}
