/**
 * The actor tier's perceive → decide → act loop (CONTEXT.md "Architecture:
 * three tiers" — Actor; CLAUDE.md Session 3). Drives one persona through
 * one goal, end to end, via Session 2's `BrowserSession` primitives.
 *
 * Perception reads the live page directly (not through `readPageState`,
 * which logs a `read-page` event) — perceiving isn't itself a user action,
 * so it shouldn't inflate the event log the way a real click or fill does.
 */

import type { Browser, Page } from "playwright";
import type { DroverDb, StoredActionEvent } from "../db/database.js";
import type { TreelineAdapter } from "../treeline/adapter.js";
import type { DomainPack, Goal, PersonaArchetype, SessionStatus } from "../types/index.js";
import type { SessionBudget } from "./budget.js";
import { evaluateCheckpoints } from "./checkpoint.js";
import { recordInSessionFinding } from "./findings.js";
import { buildActionPrompt, buildStaticSystemPrompt } from "./prompt.js";
import { type ActorDecision, MalformedDecisionError, type ModelProvider } from "./provider.js";
import { buildRouteMapContext } from "./route-map.js";

const MAX_ARIA_SNAPSHOT_CHARS = 4000;
const HISTORY_WINDOW = 6;

export interface Perception {
  url: string;
  title: string;
  ariaSnapshot: string;
}

export async function capturePerception(page: Page): Promise<Perception> {
  const url = page.url();
  const title = await page.title();
  const full = await page.locator("body").ariaSnapshot();
  const ariaSnapshot =
    full.length > MAX_ARIA_SNAPSHOT_CHARS ? `${full.slice(0, MAX_ARIA_SNAPSHOT_CHARS)}…` : full;
  return { url, title, ariaSnapshot };
}

/** patience: 0..1 — bounds how many times a failed action gets retried before hard-stopping. */
function maxRetriesForPatience(patience: number): number {
  return Math.round(1 + patience * 4);
}

/** patience: 0..1 — impatient personas act immediately, patient ones pause between actions. */
function pacingMsForPatience(patience: number): number {
  return Math.round((1 - patience) * 500);
}

interface BrowserSessionLike {
  page: Page;
  navigate(url: string, reasoning: string): Promise<string>;
  click(selector: string, reasoning: string): Promise<string>;
  fill(selector: string, value: string, reasoning: string): Promise<string>;
}

/** Returns the id of the event the primitive logged, or undefined for "finish" (no primitive). */
async function executeAction(
  session: BrowserSessionLike,
  decision: ActorDecision,
): Promise<string | undefined> {
  switch (decision.actionType) {
    case "navigate":
      return await session.navigate(decision.url as string, decision.reasoning);
    case "click":
      return await session.click(decision.selector as string, decision.reasoning);
    case "fill":
      return await session.fill(
        decision.selector as string,
        decision.value as string,
        decision.reasoning,
      );
    case "finish":
      return undefined;
  }
}

function parseHttpFailureStatus(target: string): number | undefined {
  const match = /^(\d{3})\s/.exec(target);
  return match ? Number(match[1]) : undefined;
}

async function detectAndRecordFindings(opts: {
  db: DroverDb;
  sessionId: string;
  page: Page;
  screenshotDir: string;
  eventsSeen: number;
}): Promise<{ events: StoredActionEvent[]; eventsSeen: number }> {
  const events = opts.db.getEventsBySession(opts.sessionId);
  const newEvents = events.slice(opts.eventsSeen);
  for (const event of newEvents) {
    if (event.actionType === "console-error") {
      await recordInSessionFinding({
        db: opts.db,
        sessionId: opts.sessionId,
        eventId: event.id,
        type: "console-error",
        severity: "low",
        description: event.reasoning,
        target: event.target,
        page: opts.page,
        screenshotDir: opts.screenshotDir,
        recentEvents: events,
      });
    } else if (event.actionType === "http-failure") {
      const status = parseHttpFailureStatus(event.target);
      if (status !== undefined && status >= 500) {
        await recordInSessionFinding({
          db: opts.db,
          sessionId: opts.sessionId,
          eventId: event.id,
          type: "http-failure",
          severity: "high",
          description: `HTTP ${status} response observed: ${event.target}`,
          target: event.target,
          page: opts.page,
          screenshotDir: opts.screenshotDir,
          recentEvents: events,
        });
      }
    }
  }
  return { events, eventsSeen: events.length };
}

export interface RunPersonaSessionOptions {
  db: DroverDb;
  browserSession: BrowserSessionLike;
  browser: Browser;
  sessionId: string;
  provider: ModelProvider;
  archetype: PersonaArchetype;
  domainPack: Pick<DomainPack, "appName">;
  goal: Goal;
  treelineAdapter: TreelineAdapter;
  targetBaseUrl: string;
  budget: SessionBudget;
  screenshotDir: string;
  /** Skip patience-derived pacing delays — used in tests and smoke runs. @default false */
  disablePacing?: boolean;
}

export interface PersonaSessionResult {
  status: Extract<SessionStatus, "completed" | "hard-stopped" | "budget-capped">;
  succeeded: boolean;
  reachedCheckpointIds: string[];
  actionsTaken: number;
  totalCostUsd: number;
}

export async function runPersonaSession(
  opts: RunPersonaSessionOptions,
): Promise<PersonaSessionResult> {
  const { db, browserSession, sessionId, provider, archetype, goal, budget } = opts;
  const page = browserSession.page;
  const maxRetries = maxRetriesForPatience(archetype.traits.patience);
  const pacingMs = opts.disablePacing ? 0 : pacingMsForPatience(archetype.traits.patience);

  const routeMapContext = await buildRouteMapContext(
    opts.treelineAdapter,
    opts.browser,
    opts.targetBaseUrl,
    archetype.traits.familiarity,
  );
  const systemPrompt = buildStaticSystemPrompt({
    domainPack: opts.domainPack,
    archetype,
    goal,
    ...(routeMapContext !== undefined && { routeMapContext }),
  });

  const reached = new Set<string>();
  const history: string[] = [];
  let eventsSeen = db.getEventsBySession(sessionId).length;
  let actionsTaken = 0;
  let totalCostUsd = 0;
  let status: PersonaSessionResult["status"] = "completed";
  let succeeded = false;
  let finishedEarly = false;

  outer: while (actionsTaken < goal.actionBudget) {
    for (const id of await evaluateCheckpoints(goal.checkpoints, page)) reached.add(id);
    if (reached.has(goal.successCheckpointId)) {
      succeeded = true;
      break;
    }
    if (budget.exceeded) {
      status = "budget-capped";
      break;
    }

    const perception = await capturePerception(page);
    const userPrompt = buildActionPrompt({
      perception,
      recentHistory: history.slice(-HISTORY_WINDOW),
      actionsTaken,
      actionBudget: goal.actionBudget,
    });

    let stepSucceeded = false;
    let lastErrorMessage = "";
    let attempt = 0;
    for (; attempt <= maxRetries; attempt++) {
      try {
        const { decision, usage } = await provider.decide({ systemPrompt, userPrompt });
        budget.record(usage.costUsd);
        totalCostUsd += usage.costUsd;
        history.push(`[${decision.actionType}] ${decision.reasoning}`);

        if (decision.actionType === "finish") {
          succeeded = reached.has(goal.successCheckpointId) || decision.outcome === "success";
          finishedEarly = true;
          break outer;
        }

        const eventId = await executeAction(browserSession, decision);
        stepSucceeded = true;

        if (eventId !== undefined) {
          // Tag the action that just landed with whichever checkpoint it newly
          // satisfied, if any — checkpoint state is only knowable after the
          // action's effect is on the page, so this necessarily happens after
          // the event was already written. If one action satisfies more than
          // one checkpoint at once, only the first (goal order) gets the tag;
          // all of them still count toward `reached`.
          const nowReached = await evaluateCheckpoints(goal.checkpoints, page);
          const newlyReached = nowReached.filter((id) => !reached.has(id));
          if (newlyReached.length > 0) {
            db.updateActionEventCheckpoint(eventId, newlyReached[0] as string);
            for (const id of newlyReached) reached.add(id);
          }
        }
        break;
      } catch (err) {
        lastErrorMessage = err instanceof Error ? err.message : String(err);
        // A malformed decide_action call still gets billed by the provider
        // even though parsing failed — record that spend against budget
        // rather than losing it (see GAPS.md).
        if (err instanceof MalformedDecisionError && err.usage) {
          budget.record(err.usage.costUsd);
          totalCostUsd += err.usage.costUsd;
        }
        history.push(`[error] previous attempt failed: ${lastErrorMessage}`);
      }
    }

    const detected = await detectAndRecordFindings({
      db,
      sessionId,
      page,
      screenshotDir: opts.screenshotDir,
      eventsSeen,
    });
    eventsSeen = detected.eventsSeen;

    if (!stepSucceeded) {
      status = "hard-stopped";
      if (detected.events.length > 0) {
        const lastEvent = detected.events[detected.events.length - 1] as StoredActionEvent;
        await recordInSessionFinding({
          db,
          sessionId,
          eventId: lastEvent.id,
          type: "hard-stop",
          severity: "critical",
          description: `Persona could not recover after ${attempt} attempt(s): ${lastErrorMessage}`,
          target: page.url(),
          page,
          screenshotDir: opts.screenshotDir,
          recentEvents: detected.events,
        });
      }
      break;
    }

    actionsTaken++;
    if (pacingMs > 0) await page.waitForTimeout(pacingMs);
  }

  if (status === "completed" && !succeeded && !finishedEarly) {
    const events = db.getEventsBySession(sessionId);
    const lastEvent = events[events.length - 1];
    if (lastEvent) {
      await recordInSessionFinding({
        db,
        sessionId,
        eventId: lastEvent.id,
        type: "action-budget-exhausted",
        severity: "medium",
        description: `Goal "${goal.id}" not completed within its action budget of ${goal.actionBudget}.`,
        target: page.url(),
        page,
        screenshotDir: opts.screenshotDir,
        recentEvents: events,
      });
    }
  }

  return {
    status,
    succeeded,
    reachedCheckpointIds: [...reached],
    actionsTaken,
    totalCostUsd,
  };
}
