/**
 * In-session finding creation (CONTEXT.md "Data capture & storage" /
 * "Environment & safety"). Console errors, 5xx responses, and action-budget
 * exhaustion get written to `in_session_findings` with a screenshot + short
 * trace snippet captured only at the moment the finding fires.
 *
 * `matchKey` computation here is provisional: Session 4 owns the real
 * cross-run matching key (type + normalized route + target identifier, per
 * BUILD-STATE.md). This module needs *something* now since the column is
 * NOT NULL — it strips query/hash from URL-shaped targets so at least exact
 * route repeats collapse, and will be superseded wholesale in S4.
 */

import path from "node:path";
import type { Page } from "playwright";
import { captureScreenshot } from "../browser/screenshot.js";
import type { DroverDb, StoredActionEvent } from "../db/database.js";
import { newId } from "../db/database.js";
import type { FindingSeverity, InSessionFinding, InSessionFindingType } from "../types/index.js";

const TRACE_SNIPPET_EVENTS = 5;

function normalizeTarget(target: string): string {
  try {
    const url = new URL(target);
    return `${url.origin}${url.pathname}`;
  } catch {
    // Not URL-shaped (e.g. "500 GET http://..." or a CSS selector) — use as-is.
    return target;
  }
}

/** Provisional cross-run identity key; superseded by Session 4's real matcher. */
export function computeProvisionalMatchKey(type: InSessionFindingType, target: string): string {
  return `${type}:${normalizeTarget(target)}`;
}

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
    matchKey: computeProvisionalMatchKey(opts.type, opts.target),
    ...(screenshotPath !== undefined && { screenshotPath }),
    traceSnippet: buildTraceSnippet(opts.recentEvents),
    createdAt: Date.now(),
  };
  opts.db.insertInSessionFinding(finding);
  return finding;
}
