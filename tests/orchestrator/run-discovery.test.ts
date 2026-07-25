import type { Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActorDecideResult, ModelProvider } from "../../src/actor/provider.js";
import { ScriptedModelProvider } from "../../src/actor/provider.js";
import { launchBrowser } from "../../src/browser/index.js";
import { DroverDb } from "../../src/db/database.js";
import { buildCheckpointContext, runDiscovery } from "../../src/orchestrator/run-discovery.js";
import { createTreelineAdapter, type TreelineAdapter } from "../../src/treeline/adapter.js";
import type { DomainPack, DomainPackTeardownContext, SimConfig } from "../../src/types/index.js";
import { type FixtureSite, startFixtureSite } from "../fixtures/site.js";

const TIMEOUT = 30_000;

function baseConfig(overrides?: Partial<SimConfig>): SimConfig {
  return {
    targetBaseUrl: "",
    runDimensions: { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
    budget: { runCeilingUsd: 10, perSessionSoftCapUsd: 10 },
    modelRouting: {
      actor: { provider: "scripted", model: "scripted" },
      analyst: { provider: "scripted", model: "scripted" },
    },
    ...overrides,
  };
}

describe("runDiscovery", () => {
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
  afterEach(() => db?.close());

  it(
    "runs a small schedule sequentially and survives one session hard-stopping",
    async () => {
      db = new DroverDb(":memory:");
      const before = Date.now();
      const teardownCalls: DomainPackTeardownContext[] = [];

      const domainPack: DomainPack = {
        appName: "fixture-app",
        personas: [
          {
            id: "p1",
            name: "Reliable Rae",
            traits: {
              patience: 0.5,
              techSavviness: 0.5,
              deviceType: "desktop",
              familiarity: "new",
            },
          },
          {
            id: "p2",
            name: "Impatient Ivan",
            traits: { patience: 0, techSavviness: 0.5, deviceType: "desktop", familiarity: "new" },
          },
        ],
        goals: [
          {
            id: "reach-dashboard",
            description: "Reach the dashboard.",
            actionBudget: 5,
            checkpoints: [
              { id: "on-dashboard", description: "On the dashboard.", detector: "url:/dashboard" },
            ],
            successCheckpointId: "on-dashboard",
          },
          {
            id: "impossible",
            description: "Reach an unreachable host.",
            actionBudget: 5,
            checkpoints: [{ id: "never", description: "Never.", detector: "url:/never-reached" }],
            successCheckpointId: "never",
          },
        ],
        goalWeightsByPersona: {
          p1: [{ goalId: "reach-dashboard", weight: 1 }],
          p2: [{ goalId: "impossible", weight: 1 }],
        },
        dataPolicy: "synthetic-only",
        teardown: async (ctx) => {
          teardownCalls.push(ctx);
        },
      };

      const config = baseConfig({
        targetBaseUrl: site.baseUrl,
        runDimensions: { orgSize: 2, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
      });

      const result = await runDiscovery({
        db,
        domainPack,
        config,
        screenshotDir: "runs/screenshots-test",
        browser,
        treelineAdapter: stubAdapter,
        disablePacing: true,
        providerFactory: (_route, scheduled) => {
          if (scheduled.archetypeId === "p1") {
            return new ScriptedModelProvider([
              {
                reasoning: "Go to the dashboard.",
                actionType: "navigate",
                url: `${site.baseUrl}/dashboard`,
              },
            ]);
          }
          // Unreachable host — fails fast (connection refused) rather than timing out,
          // exhausting patience=0's single retry (maxRetries = round(1 + 0*4) = 1).
          return new ScriptedModelProvider([
            {
              reasoning: "Try an unreachable page.",
              actionType: "navigate",
              url: "http://127.0.0.1:1/",
            },
            { reasoning: "Try again.", actionType: "navigate", url: "http://127.0.0.1:1/" },
          ]);
        },
      });

      expect(result.status).toBe("completed");
      expect(result.sessionsScheduled).toBe(2);
      expect(result.sessionsCompleted).toBe(1);
      expect(result.sessionsHardStopped).toBe(1);
      expect(result.sessionsErrored).toBe(0);
      expect(result.reconciliation.new).toBeGreaterThanOrEqual(1);

      const sessions = db.getSessionsByRun(result.runId);
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.status).sort()).toEqual(["completed", "hard-stopped"]);

      expect(teardownCalls).toHaveLength(1);
      const teardownCtx = teardownCalls[0];
      expect(teardownCtx?.runId).toBe(result.runId);
      expect(teardownCtx?.targetBaseUrl).toBe(site.baseUrl);
      // Both timestamps should bracket the run's actual wall-clock execution —
      // proves they're the real run's own timing, not e.g. both `Date.now()`
      // grabbed at the same instant.
      expect(teardownCtx?.runStartedAt).toBeGreaterThanOrEqual(before);
      expect(teardownCtx?.runEndedAt).toBeGreaterThanOrEqual(teardownCtx?.runStartedAt ?? 0);
      expect(teardownCtx?.runEndedAt).toBeLessThanOrEqual(Date.now());

      expect(db.getRun(result.runId)?.checkpointContext).toEqual({
        "on-dashboard": { goalId: "reach-dashboard", description: "On the dashboard." },
        never: { goalId: "impossible", description: "Never." },
      });
    },
    TIMEOUT,
  );

  it(
    "stops scheduling once the run-level cost ceiling is hit, and still tears down",
    async () => {
      db = new DroverDb(":memory:");
      const teardownCalls: DomainPackTeardownContext[] = [];

      const domainPack: DomainPack = {
        appName: "fixture-app",
        personas: [
          {
            id: "p1",
            name: "Solo",
            traits: {
              patience: 0.5,
              techSavviness: 0.5,
              deviceType: "desktop",
              familiarity: "new",
            },
          },
        ],
        goals: [
          {
            id: "trivial",
            description: "Finish immediately.",
            actionBudget: 5,
            checkpoints: [{ id: "never", description: "Never.", detector: "url:/never-reached" }],
            successCheckpointId: "never",
          },
        ],
        goalWeightsByPersona: { p1: [{ goalId: "trivial", weight: 1 }] },
        dataPolicy: "synthetic-only",
        teardown: async (ctx) => {
          teardownCalls.push(ctx);
        },
      };

      const config = baseConfig({
        targetBaseUrl: site.baseUrl,
        runDimensions: { orgSize: 5, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
        budget: { runCeilingUsd: 0.5, perSessionSoftCapUsd: 10 },
      });

      const result = await runDiscovery({
        db,
        domainPack,
        config,
        screenshotDir: "runs/screenshots-test",
        browser,
        treelineAdapter: stubAdapter,
        disablePacing: true,
        providerFactory: () =>
          new ScriptedModelProvider(
            [{ reasoning: "Done.", actionType: "finish", outcome: "success" }],
            0.5,
          ),
      });

      expect(result.status).toBe("budget-stopped");
      expect(result.sessionsScheduled).toBe(1);
      expect(result.sessionsCompleted).toBe(1);
      expect(result.totalCostUsd).toBeCloseTo(0.5);
      expect(teardownCalls).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "tears down and marks the run crashed when scheduling references an unknown goal",
    async () => {
      db = new DroverDb(":memory:");
      const teardownCalls: DomainPackTeardownContext[] = [];

      const domainPack: DomainPack = {
        appName: "fixture-app",
        personas: [
          {
            id: "p1",
            name: "Solo",
            traits: {
              patience: 0.5,
              techSavviness: 0.5,
              deviceType: "desktop",
              familiarity: "new",
            },
          },
        ],
        goals: [],
        goalWeightsByPersona: { p1: [{ goalId: "ghost-goal", weight: 1 }] },
        dataPolicy: "synthetic-only",
        teardown: async (ctx) => {
          teardownCalls.push(ctx);
        },
      };

      const config = baseConfig({ targetBaseUrl: site.baseUrl });

      await expect(
        runDiscovery({
          db,
          domainPack,
          config,
          screenshotDir: "runs/screenshots-test",
          browser,
          treelineAdapter: stubAdapter,
          disablePacing: true,
          providerFactory: () => new ScriptedModelProvider([]),
        }),
      ).rejects.toThrow(/unknown persona|unknown.*goal/i);

      expect(teardownCalls).toHaveLength(1);
      const crashedRun = db.getRun(teardownCalls[0]?.runId ?? "");
      expect(crashedRun?.status).toBe("crashed");
    },
    TIMEOUT,
  );

  it.each([0, -1, 2.5, Number.NaN])(
    "rejects an invalid concurrencyCap (%s) before writing the run row",
    async (invalidCap) => {
      db = new DroverDb(":memory:");

      const domainPack: DomainPack = {
        appName: "fixture-app",
        personas: [
          {
            id: "p1",
            name: "Solo",
            traits: {
              patience: 0.5,
              techSavviness: 0.5,
              deviceType: "desktop",
              familiarity: "new",
            },
          },
        ],
        goals: [
          {
            id: "trivial",
            description: "Finish immediately.",
            actionBudget: 5,
            checkpoints: [{ id: "never", description: "Never.", detector: "url:/never-reached" }],
            successCheckpointId: "never",
          },
        ],
        goalWeightsByPersona: { p1: [{ goalId: "trivial", weight: 1 }] },
        dataPolicy: "synthetic-only",
      };

      const config = baseConfig({ targetBaseUrl: site.baseUrl, concurrencyCap: invalidCap });

      const insertRunSpy = vi.spyOn(db, "insertRun");

      await expect(
        runDiscovery({
          db,
          domainPack,
          config,
          screenshotDir: "runs/screenshots-test",
          browser,
          treelineAdapter: stubAdapter,
          disablePacing: true,
          providerFactory: () => new ScriptedModelProvider([]),
        }),
      ).rejects.toThrow(/concurrencyCap/);

      // The guard must fire before any run row is written — a rejected config
      // shouldn't leave a "running" run behind for a pack author to find later.
      expect(insertRunSpy).not.toHaveBeenCalled();
    },
  );

  it(
    "actually overlaps sessions in time when concurrencyCap is above 1, and completes them all",
    async () => {
      db = new DroverDb(":memory:");

      const domainPack: DomainPack = {
        appName: "fixture-app",
        personas: [
          {
            id: "p1",
            name: "Quick",
            traits: {
              patience: 0.5,
              techSavviness: 0.5,
              deviceType: "desktop",
              familiarity: "new",
            },
          },
        ],
        goals: [
          {
            id: "trivial",
            description: "Finish immediately.",
            actionBudget: 5,
            checkpoints: [{ id: "never", description: "Never.", detector: "url:/never-reached" }],
            successCheckpointId: "never",
          },
        ],
        goalWeightsByPersona: { p1: [{ goalId: "trivial", weight: 1 }] },
        dataPolicy: "synthetic-only",
      };

      const config = baseConfig({
        targetBaseUrl: site.baseUrl,
        runDimensions: { orgSize: 6, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
        concurrencyCap: 3,
      });

      // Every session's provider blocks for DELAY_MS on its one decide() call
      // before resolving "finish/success" — with 6 sessions, cap 3, and a
      // real delay, peak concurrent in-flight decide() calls can only exceed
      // 1 if runDiscovery is actually overlapping sessions, not just
      // permitting a cap above 1 while still running them one at a time.
      const DELAY_MS = 100;
      let active = 0;
      let maxActive = 0;

      class DelayedFinishProvider implements ModelProvider {
        readonly provider = "delayed-finish";
        readonly model = "delayed-finish";
        async decide(): Promise<ActorDecideResult> {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
          active--;
          return {
            decision: {
              reasoning: "Finishing right away.",
              actionType: "finish",
              outcome: "success",
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              costUsd: 0,
            },
          };
        }
      }

      const result = await runDiscovery({
        db,
        domainPack,
        config,
        screenshotDir: "runs/screenshots-test",
        browser,
        treelineAdapter: stubAdapter,
        disablePacing: true,
        providerFactory: () => new DelayedFinishProvider(),
      });

      expect(result.status).toBe("completed");
      expect(result.sessionsScheduled).toBe(6);
      expect(result.sessionsCompleted).toBe(6);
      expect(result.sessionsErrored).toBe(0);
      expect(result.sessionsHardStopped).toBe(0);
      // The real proof of concurrency: more than one session's decide() call
      // was in flight at the same wall-clock moment.
      expect(maxActive).toBeGreaterThan(1);
    },
    TIMEOUT,
  );
});

describe("buildCheckpointContext", () => {
  it("maps every checkpoint id to its owning goal id and description", () => {
    const domainPack: DomainPack = {
      appName: "fixture-app",
      personas: [],
      goals: [
        {
          id: "goal-a",
          description: "Goal A.",
          actionBudget: 5,
          checkpoints: [
            { id: "cp-1", description: "First checkpoint.", detector: "url:/one" },
            { id: "cp-2", description: "Second checkpoint.", detector: "url:/two" },
          ],
          successCheckpointId: "cp-2",
        },
        {
          id: "goal-b",
          description: "Goal B.",
          actionBudget: 5,
          checkpoints: [{ id: "cp-3", description: "Third checkpoint.", detector: "url:/three" }],
          successCheckpointId: "cp-3",
        },
      ],
      goalWeightsByPersona: {},
      dataPolicy: "synthetic-only",
    };

    expect(buildCheckpointContext(domainPack)).toEqual({
      "cp-1": { goalId: "goal-a", description: "First checkpoint." },
      "cp-2": { goalId: "goal-a", description: "Second checkpoint." },
      "cp-3": { goalId: "goal-b", description: "Third checkpoint." },
    });
  });

  it("returns an empty map for a domain pack with no goals", () => {
    const domainPack: DomainPack = {
      appName: "fixture-app",
      personas: [],
      goals: [],
      goalWeightsByPersona: {},
      dataPolicy: "synthetic-only",
    };

    expect(buildCheckpointContext(domainPack)).toEqual({});
  });
});
