/**
 * In-session finding creation (CONTEXT.md "Data capture & storage" /
 * "Environment & safety"). Console errors, 5xx responses, and action-budget
 * exhaustion get written to `in_session_findings` with a screenshot + short
 * trace snippet captured only at the moment the finding fires.
 *
 * `matchKey` is computed via src/matching/match-key.ts, shared with the
 * Session 4 orchestrator's cross-run reconciliation.
 */

import path from "node:path";
import type { Page } from "playwright";
import { captureScreenshot } from "../browser/screenshot.js";
import type { DroverDb, StoredActionEvent } from "../db/database.js";
import { newId } from "../db/database.js";
import { computeMatchKey } from "../matching/match-key.js";
import type { FindingSeverity, InSessionFinding, InSessionFindingType } from "../types/index.js";

const TRACE_SNIPPET_EVENTS = 5;

/** Short text summary of the last few events — the "trace snippet", not a full Playwright trace. */
export function buildTraceSnippet(
  events: StoredActionEvent[],
  count: number = TRACE_SNIPPET_EVENTS,
): string {
  return events
    .slice(-count)
    .map((e) => `[${e.actionType}] ${e.target} — ${e.reasoning}`)
    .join("\n");
}

export interface RecordFindingOptions {
  db: DroverDb;
  sessionId: string;
  eventId: string;
  type: InSessionFindingType;
  severity: FindingSeverity;
  description: string;
  target: string;
  page: Page;
  screenshotDir: string;
  recentEvents: StoredActionEvent[];
}

/** Captures evidence and writes an in_session_findings row; never throws. */
export async function recordInSessionFinding(
  opts: RecordFindingOptions,
): Promise<InSessionFinding> {
  const screenshotPath = await captureScreenshot(
    opts.page,
    path.join(opts.screenshotDir, opts.sessionId),
    opts.type,
  );
  const finding: InSessionFinding = {
    id: newId(),
    sessionId: opts.sessionId,
    eventId: opts.eventId,
    type: opts.type,
    severity: opts.severity,
    description: opts.description,
    matchKey: computeMatchKey(opts.type, opts.target),
    ...(screenshotPath !== undefined && { screenshotPath }),
    traceSnippet: buildTraceSnippet(opts.recentEvents),
    createdAt: Date.now(),
  };
  opts.db.insertInSessionFinding(finding);
  return finding;
}
