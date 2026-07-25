import type { Browser } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launchBrowser } from "../../src/browser/index.js";
import { DroverDb, newId } from "../../src/db/database.js";
import { InvalidStampedeOptionsError, runStampede } from "../../src/stampede/run-stampede.js";
import type { PersonaSession, Run, SimConfig } from "../../src/types/index.js";
import { type FixtureSite, startFixtureSite } from "../fixtures/site.js";

const INTEGRATION_TIMEOUT = 30_000;

describe("runStampede", () => {
  let browser: Browser;
  let site: FixtureSite;
  let db: DroverDb;

  beforeAll(async () => {
    browser = await launchBrowser();
    site = await startFixtureSite();
  }, INTEGRATION_TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  beforeEach(() => {
    db = new DroverDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function makeDiscoveryRun(): Run {
    const config: SimConfig = {
      targetBaseUrl: site.baseUrl,
      runDimensions: { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
      budget: { runCeilingUsd: 1, perSessionSoftCapUsd: 1 },
      modelRouting: {
        actor: { provider: "scripted", model: "scripted" },
        analyst: { provider: "scripted", model: "scripted" },
      },
    };
    const run: Run = {
      id: newId(),
      appName: "fixture-app",
      config,
      status: "completed",
      startedAt: 1000,
    };
    db.insertRun(run);

    const session: PersonaSession = {
      id: newId(),
      runId: run.id,
      personaId: "impatient-rushed",
      goalId: "check-in",
      status: "completed",
      startedAt: 1000,
      endedAt: 2000,
    };
    db.insertSession(session);

    for (const target of ["/", "/horses", "/api/horses/page2"]) {
      db.insertActionEvent({
        sessionId: session.id,
        timestamp: 1000,
        actionType: "navigate",
        target: `${site.baseUrl}${target}`,
        reasoning: "test",
      });
    }
    return run;
  }

  it(
    "replays a discovery run's routes at each concurrency level and stores per-route percentile/error results",
    async () => {
      const sourceRun = makeDiscoveryRun();

      const result = await runStampede({
        db,
        sourceRunId: sourceRun.id,
        browser,
        concurrencyLevels: [1, 2],
        iterationsPerWorker: 1,
        navigationTimeoutMs: 5000,
      });

      expect(result.sourceRunId).toBe(sourceRun.id);
      expect(result.targetBaseUrl).toBe(site.baseUrl);
      expect(result.routes.sort()).toEqual(["/", "/api/horses/page2", "/horses"]);
      // 3 routes x 2 concurrency levels = 6 (route, concurrency) groups.
      expect(result.results).toHaveLength(6);

      for (const summary of result.results) {
        expect(summary.p50Ms).toBeLessThanOrEqual(summary.p95Ms);
        expect(summary.p95Ms).toBeLessThanOrEqual(summary.p99Ms);
        expect(summary.sampleCount).toBe(summary.concurrency);
      }

      const errorRoute = result.results.filter((r) => r.route === "/api/horses/page2");
      expect(errorRoute.every((r) => r.errorCount === r.sampleCount)).toBe(true);

      const goodRoute = result.results.filter((r) => r.route === "/");
      expect(goodRoute.every((r) => r.errorCount === 0)).toBe(true);

      const storedRun = db.getStampedeRun(result.stampedeRunId);
      expect(storedRun?.sourceRunId).toBe(sourceRun.id);
      expect(storedRun?.targetBaseUrl).toBe(site.baseUrl);
      expect(storedRun?.concurrencyLevels).toEqual([1, 2]);
      expect(storedRun?.endedAt).toBeDefined();

      const storedResults = db.getStampedeRouteResultsByRun(result.stampedeRunId);
      expect(storedResults).toHaveLength(6);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    "accepts an explicit route list + targetBaseUrl without a source run",
    async () => {
      const result = await runStampede({
        db,
        routes: ["/", "/horses"],
        targetBaseUrl: site.baseUrl,
        browser,
        concurrencyLevels: [1],
        iterationsPerWorker: 1,
        navigationTimeoutMs: 5000,
      });

      expect(result.sourceRunId).toBeUndefined();
      expect(result.results).toHaveLength(2);
      expect(db.getStampedeRun(result.stampedeRunId)?.sourceRunId).toBeUndefined();
    },
    INTEGRATION_TIMEOUT,
  );

  it("rejects both sourceRunId and routes given together", async () => {
    await expect(
      runStampede({ db, sourceRunId: "x", routes: ["/"], targetBaseUrl: site.baseUrl }),
    ).rejects.toThrow(InvalidStampedeOptionsError);
  });

  it("rejects neither sourceRunId nor routes given", async () => {
    await expect(runStampede({ db })).rejects.toThrow(InvalidStampedeOptionsError);
  });

  it("rejects routes without targetBaseUrl", async () => {
    await expect(runStampede({ db, routes: ["/"] })).rejects.toThrow(InvalidStampedeOptionsError);
  });
});
