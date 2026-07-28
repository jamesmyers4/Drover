import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionBudget } from "../../src/actor/budget.js";
import { runPersonaSession } from "../../src/actor/loop.js";
import {
  type ActorDecideResult,
  MalformedDecisionError,
  type ModelProvider,
  ScriptedModelProvider,
} from "../../src/actor/provider.js";
import { BrowserSession, launchBrowser } from "../../src/browser/session.js";
import { DroverDb, newId } from "../../src/db/database.js";
import { createTreelineAdapter, type TreelineAdapter } from "../../src/treeline/adapter.js";
import type { DomainPack, Goal, PersonaArchetype } from "../../src/types/index.js";
import { type FixtureSite, startFixtureSite } from "../fixtures/site.js";

const TIMEOUT = 30_000;

const domainPack: Pick<DomainPack, "appName"> = { appName: "Fixture App" };

/**
 * Real click/fill decisions now carry an aria-ref (see src/actor/loop.ts),
 * not a CSS selector — look up the current ref for an element the same way
 * the model does, from a `body`-rooted snapshot (matching capturePerception
 * exactly), rather than hardcoding a magic `eN` literal that's an
 * implementation detail of Playwright's own numbering. Ref numbering is
 * scoped to the snapshot's traversal root — an isolated per-element snapshot
 * (e.g. `page.locator(cssSelector).ariaSnapshot()`) numbers from that
 * element as its own root and gives a *different* ref than a body-rooted
 * one, so this must match capturePerception's root exactly or the ref won't
 * resolve later.
 */
async function refFor(page: Page, roleAndAccessibleName: string): Promise<string> {
  const snapshot = await page.locator("body").ariaSnapshot({ mode: "ai" });
  const escaped = roleAndAccessibleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}[^[]*\\[ref=(\\w+)\\]`).exec(snapshot);
  if (!match) {
    throw new Error(`no ref found for "${roleAndAccessibleName}" in snapshot:\n${snapshot}`);
  }
  return match[1] as string;
}

function makeArchetype(overrides?: Partial<PersonaArchetype["traits"]>): PersonaArchetype {
  return {
    id: "test-persona",
    name: "Test Persona",
    traits: {
      patience: 0.5,
      techSavviness: 0.5,
      deviceType: "desktop",
      familiarity: "new",
      ...overrides,
    },
  };
}

describe("runPersonaSession", () => {
  let browser: Browser;
  let site: FixtureSite;
  let stubAdapter: TreelineAdapter;

  beforeAll(async () => {
    browser = await launchBrowser();
    site = await startFixtureSite();
    stubAdapter = await createTreelineAdapter("Z:/definitely/not/here");
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  let db: DroverDb;
  let session: BrowserSession;
  let sessionId: string;

  afterEach(async () => {
    await session?.close();
    db?.close();
  });

  async function setUp(): Promise<void> {
    db = new DroverDb(":memory:");
    const runId = newId();
    sessionId = newId();
    db.insertRun({
      id: runId,
      appName: domainPack.appName,
      config: {
        targetBaseUrl: site.baseUrl,
        runDimensions: { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
        budget: { runCeilingUsd: 10, perSessionSoftCapUsd: 1 },
        modelRouting: {
          actor: { provider: "scripted", model: "scripted" },
          analyst: { provider: "scripted", model: "scripted" },
        },
      },
      status: "running",
      startedAt: Date.now(),
    });
    db.insertSession({
      id: sessionId,
      runId,
      personaId: "test-persona",
      goalId: "test-goal",
      status: "running",
      startedAt: Date.now(),
    });
    session = await BrowserSession.open(browser, { sessionId, db, deviceType: "desktop" });
  }

  it(
    "succeeds when the success checkpoint is reached",
    async () => {
      await setUp();
      const goal: Goal = {
        id: "reach-dashboard",
        description: "Reach the dashboard.",
        actionBudget: 5,
        checkpoints: [
          { id: "on-dashboard", description: "On the dashboard.", detector: "url:/dashboard" },
        ],
        successCheckpointId: "on-dashboard",
      };
      const provider = new ScriptedModelProvider([
        { reasoning: "Start at the home page.", actionType: "navigate", url: `${site.baseUrl}/` },
        {
          reasoning: "Go to the dashboard.",
          actionType: "navigate",
          url: `${site.baseUrl}/dashboard`,
        },
      ]);

      const result = await runPersonaSession({
        db,
        browserSession: session,
        browser,
        sessionId,
        provider,
        archetype: makeArchetype(),
        domainPack,
        goal,
        treelineAdapter: stubAdapter,
        targetBaseUrl: site.baseUrl,
        budget: new SessionBudget(1),
        screenshotDir: "runs/screenshots-test",
        disablePacing: true,
      });

      expect(result.status).toBe("completed");
      expect(result.succeeded).toBe(true);
      expect(result.reachedCheckpointIds).toEqual(["on-dashboard"]);
      expect(result.actionsTaken).toBe(2);

      // The navigate that actually landed on /dashboard should be tagged
      // with the checkpoint it satisfied; nothing before it should be.
      const events = db.getEventsBySession(sessionId);
      const dashboardNav = events.find((e) => e.target === `${site.baseUrl}/dashboard`);
      expect(dashboardNav?.checkpointId).toBe("on-dashboard");
      const homeNav = events.find((e) => e.target === `${site.baseUrl}/`);
      expect(homeNav?.checkpointId).toBeUndefined();

      // Screenshots are only captured via recordInSessionFinding (src/actor/
      // findings.ts) at the moment a finding fires — never per-action. A
      // clean run with zero findings is the proxy for that: no finding means
      // no captureScreenshot call ever happened.
      expect(db.getInSessionFindingsBySession(sessionId)).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "records in-session findings for console errors and 5xx responses",
    async () => {
      await setUp();
      const goal: Goal = {
        id: "never-succeeds",
        description: "Wander around.",
        actionBudget: 5,
        checkpoints: [{ id: "on-signup", description: "On signup.", detector: "url:/signup" }],
        successCheckpointId: "on-signup",
      };
      const provider = new ScriptedModelProvider([
        {
          reasoning: "Visit the known-broken page.",
          actionType: "navigate",
          url: `${site.baseUrl}/broken`,
        },
        {
          reasoning: "Try to load more horses.",
          actionType: "navigate",
          url: `${site.baseUrl}/api/horses/page2`,
        },
        { reasoning: "Give up.", actionType: "finish", outcome: "gave-up" },
      ]);

      const result = await runPersonaSession({
        db,
        browserSession: session,
        browser,
        sessionId,
        provider,
        archetype: makeArchetype(),
        domainPack,
        goal,
        treelineAdapter: stubAdapter,
        targetBaseUrl: site.baseUrl,
        budget: new SessionBudget(1),
        screenshotDir: "runs/screenshots-test",
        disablePacing: true,
      });

      expect(result.succeeded).toBe(false);
      expect(result.status).toBe("completed");

      const findings = db.getInSessionFindingsBySession(sessionId);
      // Chromium separately logs its own "Failed to load resource" console
      // error for the 500 response, alongside our tracked http-failure event
      // for the same response — so at least one of each type is expected,
      // not an exact count (avoids over-fitting to browser console noise).
      expect(findings.some((f) => f.type === "console-error")).toBe(true);
      const httpFinding = findings.find((f) => f.type === "http-failure");
      expect(httpFinding?.severity).toBe("high");
      expect(httpFinding?.screenshotPath).toBeDefined();
    },
    TIMEOUT,
  );

  it(
    "records a page-error finding for an uncaught JS exception, distinct from console-error",
    async () => {
      await setUp();
      const goal: Goal = {
        id: "never-succeeds",
        description: "Wander around.",
        actionBudget: 2,
        checkpoints: [{ id: "on-signup", description: "On signup.", detector: "url:/signup" }],
        successCheckpointId: "on-signup",
      };
      const provider = new ScriptedModelProvider([
        {
          reasoning: "Visit the page that throws.",
          actionType: "navigate",
          url: `${site.baseUrl}/throws`,
        },
        { reasoning: "Give up.", actionType: "finish", outcome: "gave-up" },
      ]);

      const result = await runPersonaSession({
        db,
        browserSession: session,
        browser,
        sessionId,
        provider,
        archetype: makeArchetype(),
        domainPack,
        goal,
        treelineAdapter: stubAdapter,
        targetBaseUrl: site.baseUrl,
        budget: new SessionBudget(1),
        screenshotDir: "runs/screenshots-test",
        disablePacing: true,
      });

      expect(result.succeeded).toBe(false);
      const findings = db.getInSessionFindingsBySession(sessionId);
      const pageErrorFinding = findings.find((f) => f.type === "page-error");
      expect(pageErrorFinding).toBeDefined();
      expect(pageErrorFinding?.severity).toBe("high");
      expect(pageErrorFinding?.screenshotPath).toBeDefined();
    },
    TIMEOUT,
  );

  it(
    "ends budget-capped once the soft cap is spent, distinct from a hard-stop",
    async () => {
      await setUp();
      const goal: Goal = {
        id: "long-goal",
        description: "Keep browsing.",
        actionBudget: 5,
        checkpoints: [{ id: "never", description: "Never.", detector: "url:/never-reached" }],
        successCheckpointId: "never",
      };
      const provider = new ScriptedModelProvider(
        [
          { reasoning: "Go home.", actionType: "navigate", url: `${site.baseUrl}/` },
          { reasoning: "Go to horses.", actionType: "navigate", url: `${site.baseUrl}/horses` },
        ],
        0.001,
      );

      const result = await runPersonaSession({
        db,
        browserSession: session,
        browser,
        sessionId,
        provider,
        archetype: makeArchetype(),
        domainPack,
        goal,
        treelineAdapter: stubAdapter,
        targetBaseUrl: site.baseUrl,
        budget: new SessionBudget(0.001),
        screenshotDir: "runs/screenshots-test",
        disablePacing: true,
      });

      expect(result.status).toBe("budget-capped");
      expect(result.actionsTaken).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "hard-stops after patience-bounded retries are exhausted on a persistently failing action",
    async () => {
      await setUp();
      const goal: Goal = {
        id: "impossible",
        description: "Click something that doesn't exist.",
        actionBudget: 5,
        checkpoints: [{ id: "never", description: "Never.", detector: "url:/never-reached" }],
        successCheckpointId: "never",
      };
      // A ref that was never handed out by any real snapshot never resolves,
      // regardless of page content — exercises the click primitive's own
      // fail-fast timeout for a bad aria-ref (src/browser/session.ts), not
      // Playwright's 30s default. Same failing click every attempt —
      // patience=0 bounds retries to 1 (maxRetries = round(1+0*4)).
      const provider = new ScriptedModelProvider([
        {
          reasoning: "Click a button that isn't there.",
          actionType: "click",
          selector: "e9999",
        },
        { reasoning: "Try again.", actionType: "click", selector: "e9999" },
      ]);

      const result = await runPersonaSession({
        db,
        browserSession: session,
        browser,
        sessionId,
        provider,
        archetype: makeArchetype({ patience: 0 }),
        domainPack,
        goal,
        treelineAdapter: stubAdapter,
        targetBaseUrl: site.baseUrl,
        budget: new SessionBudget(1),
        screenshotDir: "runs/screenshots-test",
        disablePacing: true,
      });

      expect(result.status).toBe("hard-stopped");
      expect(result.actionsTaken).toBe(0);
      const findings = db.getInSessionFindingsBySession(sessionId);
      expect(findings.some((f) => f.type === "hard-stop" && f.severity === "critical")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "writes an action-budget-exhausted finding when the goal isn't reached in time",
    async () => {
      await setUp();
      const goal: Goal = {
        id: "tight-budget",
        description: "Do one thing.",
        actionBudget: 1,
        checkpoints: [{ id: "never", description: "Never.", detector: "url:/never-reached" }],
        successCheckpointId: "never",
      };
      const provider = new ScriptedModelProvider([
        { reasoning: "Go to horses.", actionType: "navigate", url: `${site.baseUrl}/horses` },
      ]);

      const result = await runPersonaSession({
        db,
        browserSession: session,
        browser,
        sessionId,
        provider,
        archetype: makeArchetype(),
        domainPack,
        goal,
        treelineAdapter: stubAdapter,
        targetBaseUrl: site.baseUrl,
        budget: new SessionBudget(1),
        screenshotDir: "runs/screenshots-test",
        disablePacing: true,
      });

      expect(result.status).toBe("completed");
      expect(result.succeeded).toBe(false);
      expect(result.actionsTaken).toBe(1);
      const findings = db.getInSessionFindingsBySession(sessionId);
      expect(findings.some((f) => f.type === "action-budget-exhausted")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "still completes correctly with pacing enabled (patience-derived wait between actions)",
    async () => {
      await setUp();
      const goal: Goal = {
        id: "reach-dashboard-paced",
        description: "Reach the dashboard.",
        actionBudget: 5,
        checkpoints: [
          { id: "on-dashboard", description: "On the dashboard.", detector: "url:/dashboard" },
        ],
        successCheckpointId: "on-dashboard",
      };
      const provider = new ScriptedModelProvider([
        { reasoning: "Start at the home page.", actionType: "navigate", url: `${site.baseUrl}/` },
        {
          reasoning: "Go to the dashboard.",
          actionType: "navigate",
          url: `${site.baseUrl}/dashboard`,
        },
      ]);

      // patience: 0 -> pacingMsForPatience(0) = 500ms, the longest real wait
      // this trait can produce — proves pacing doesn't break the loop, not
      // just that disablePacing:true (every other test's default) works.
      const result = await runPersonaSession({
        db,
        browserSession: session,
        browser,
        sessionId,
        provider,
        archetype: makeArchetype({ patience: 0 }),
        domainPack,
        goal,
        treelineAdapter: stubAdapter,
        targetBaseUrl: site.baseUrl,
        budget: new SessionBudget(1),
        screenshotDir: "runs/screenshots-test",
      });

      expect(result.status).toBe("completed");
      expect(result.succeeded).toBe(true);
      expect(result.actionsTaken).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "executes a fill decision end to end and records the event",
    async () => {
      await setUp();
      // Look up the real ref the model would see in its own page snapshot —
      // navigating the raw page directly (not through session.navigate(),
      // which would log an extra event this test doesn't expect) before the
      // scripted flow's own navigate re-visits the same page for real.
      await session.page.goto(`${site.baseUrl}/signup`);
      const nameRef = await refFor(session.page, 'textbox "Name"');

      const goal: Goal = {
        id: "fill-signup",
        description: "Fill out the signup form.",
        actionBudget: 2,
        checkpoints: [{ id: "never", description: "Never.", detector: "url:/never-reached" }],
        successCheckpointId: "never",
      };
      const provider = new ScriptedModelProvider([
        {
          reasoning: "Go to the signup form.",
          actionType: "navigate",
          url: `${site.baseUrl}/signup`,
        },
        {
          reasoning: "Enter my name.",
          actionType: "fill",
          selector: nameRef,
          value: "Jane Volunteer",
        },
      ]);

      const result = await runPersonaSession({
        db,
        browserSession: session,
        browser,
        sessionId,
        provider,
        archetype: makeArchetype(),
        domainPack,
        goal,
        treelineAdapter: stubAdapter,
        targetBaseUrl: site.baseUrl,
        budget: new SessionBudget(1),
        screenshotDir: "runs/screenshots-test",
        disablePacing: true,
      });

      expect(result.status).toBe("completed");
      expect(result.actionsTaken).toBe(2);

      const events = db.getEventsBySession(sessionId);
      const fillEvent = events.find((e) => e.actionType === "fill");
      expect(fillEvent).toBeDefined();
      expect(fillEvent?.target).toBe(`aria-ref=${nameRef}`);
      // The action budget was exhausted (the goal's checkpoint is never
      // reachable), which is expected here — this test's own point is that
      // the fill primitive ran and got logged, not that the goal succeeded.
      const findings = db.getInSessionFindingsBySession(sessionId);
      expect(findings.some((f) => f.type === "action-budget-exhausted")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "records the billed cost of a malformed decide_action call against budget, not just successful ones",
    async () => {
      await setUp();
      const goal: Goal = {
        id: "finish-goal",
        description: "Finish right away.",
        actionBudget: 5,
        checkpoints: [{ id: "never", description: "Never.", detector: "url:/never-reached" }],
        successCheckpointId: "never",
      };

      let calls = 0;
      const provider: ModelProvider = {
        provider: "test-malformed",
        model: "test-malformed",
        async decide(): Promise<ActorDecideResult> {
          calls++;
          if (calls === 1) {
            // Simulates the real AnthropicModelProvider: the API call came
            // back and was billed, but the tool call didn't parse — usage
            // still travels with the thrown error (see src/actor/provider.ts).
            throw new MalformedDecisionError("simulated malformed tool call", {
              inputTokens: 100,
              outputTokens: 10,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              costUsd: 0.01,
            });
          }
          return {
            decision: { reasoning: "Give up.", actionType: "finish", outcome: "gave-up" },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              costUsd: 0.002,
            },
          };
        },
      };

      const budget = new SessionBudget(1);
      const result = await runPersonaSession({
        db,
        browserSession: session,
        browser,
        sessionId,
        provider,
        archetype: makeArchetype(),
        domainPack,
        goal,
        treelineAdapter: stubAdapter,
        targetBaseUrl: site.baseUrl,
        budget,
        screenshotDir: "runs/screenshots-test",
        disablePacing: true,
      });

      expect(calls).toBe(2);
      // Both the malformed call's billed cost (0.01) and the successful
      // retry's cost (0.002) must be reflected — not just the successful one.
      expect(result.totalCostUsd).toBeCloseTo(0.012, 6);
      expect(budget.spent).toBeCloseTo(0.012, 6);
    },
    TIMEOUT,
  );
});
