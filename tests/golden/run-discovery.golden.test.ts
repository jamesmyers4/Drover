/**
 * Golden-master pipeline layer (TESTING.md Session 3): locks down full
 * `runDiscovery` behavior — real fixture browser, scripted model providers —
 * against checked-in golden files, so a change that silently alters real
 * end-to-end behavior fails here even when every individual unit test still
 * passes in isolation. Driven directly through `runDiscovery` (same pattern
 * as `tests/orchestrator/run-discovery.test.ts`), not a CLI subprocess.
 *
 * A 4th scenario covering `drover analyze`'s cross-session output is
 * deliberately deferred — see TESTING.md Session 3's own note: not worth
 * locking down raw `cross_session_findings` rows before Session 6's
 * reporting work gives them a real consumer.
 *
 * Regenerate with `UPDATE_GOLDEN=1 npm test -- tests/golden`.
 */

import type { Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModelProvider } from "../../src/actor/provider.js";
import { launchBrowser } from "../../src/browser/index.js";
import { DroverDb } from "../../src/db/database.js";
import { runDiscovery } from "../../src/orchestrator/run-discovery.js";
import { createTreelineAdapter, type TreelineAdapter } from "../../src/treeline/adapter.js";
import type { DomainPack, SimConfig } from "../../src/types/index.js";
import { type FixtureSite, startFixtureSite } from "../fixtures/site.js";
import { dumpRun } from "./dump-run.js";
import { expectMatchesGolden } from "./golden-file.js";
import { normalizeGolden } from "./normalize-golden.js";

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

describe("runDiscovery golden scenarios", () => {
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
    "clean run — every persona reaches its checkpoint, no findings",
    async () => {
      db = new DroverDb(":memory:");

      const domainPack: DomainPack = {
        appName: "golden-fixture-app",
        personas: [
          {
            id: "p-dashboard",
            name: "Steady Sam",
            traits: {
              patience: 0.5,
              techSavviness: 0.5,
              deviceType: "desktop",
              familiarity: "new",
            },
          },
          {
            id: "p-horses",
            name: "Curious Cara",
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
            id: "g-dashboard",
            description: "Reach the dashboard.",
            actionBudget: 5,
            checkpoints: [
              { id: "on-dashboard", description: "On the dashboard.", detector: "url:/dashboard" },
            ],
            successCheckpointId: "on-dashboard",
          },
          {
            id: "g-horses",
            description: "Browse the horses.",
            actionBudget: 5,
            checkpoints: [
              { id: "on-horses", description: "On the horses page.", detector: "url:/horses" },
            ],
            successCheckpointId: "on-horses",
          },
        ],
        goalWeightsByPersona: {
          "p-dashboard": [{ goalId: "g-dashboard", weight: 1 }],
          "p-horses": [{ goalId: "g-horses", weight: 1 }],
        },
        dataPolicy: "synthetic-only",
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
        random: () => 0,
        providerFactory: (_route, scheduled) => {
          if (scheduled.archetypeId === "p-dashboard") {
            return new ScriptedModelProvider(
              [
                {
                  reasoning: "Go to the dashboard.",
                  actionType: "navigate",
                  url: `${site.baseUrl}/dashboard`,
                },
              ],
              0.01,
            );
          }
          return new ScriptedModelProvider(
            [
              {
                reasoning: "Go browse the horses.",
                actionType: "navigate",
                url: `${site.baseUrl}/horses`,
              },
            ],
            0.01,
          );
        },
      });

      const dump = normalizeGolden(dumpRun(db, result), { baseUrl: site.baseUrl });
      expectMatchesGolden("clean-run", dump);
    },
    TIMEOUT,
  );

  it(
    "mixed outcomes — one succeeds, one hard-stops, one hits an in-session finding",
    async () => {
      db = new DroverDb(":memory:");

      const domainPack: DomainPack = {
        appName: "golden-fixture-app",
        personas: [
          {
            id: "p-success",
            name: "Steady Sam",
            traits: {
              patience: 0.5,
              techSavviness: 0.5,
              deviceType: "desktop",
              familiarity: "new",
            },
          },
          {
            id: "p-hardstop",
            name: "Impatient Ivan",
            traits: { patience: 0, techSavviness: 0.5, deviceType: "desktop", familiarity: "new" },
          },
          {
            id: "p-finding",
            name: "Wandering Wendy",
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
            id: "g-success",
            description: "Reach the dashboard.",
            actionBudget: 5,
            checkpoints: [
              { id: "on-dashboard", description: "On the dashboard.", detector: "url:/dashboard" },
            ],
            successCheckpointId: "on-dashboard",
          },
          {
            id: "g-hardstop",
            description: "Reach an unreachable host.",
            actionBudget: 5,
            checkpoints: [{ id: "never", description: "Never.", detector: "url:/never-reached" }],
            successCheckpointId: "never",
          },
          {
            id: "g-finding",
            description: "Wander onto the known-broken page.",
            actionBudget: 5,
            checkpoints: [{ id: "on-signup", description: "On signup.", detector: "url:/signup" }],
            successCheckpointId: "on-signup",
          },
        ],
        goalWeightsByPersona: {
          "p-success": [{ goalId: "g-success", weight: 1 }],
          "p-hardstop": [{ goalId: "g-hardstop", weight: 1 }],
          "p-finding": [{ goalId: "g-finding", weight: 1 }],
        },
        dataPolicy: "synthetic-only",
      };

      const config = baseConfig({
        targetBaseUrl: site.baseUrl,
        runDimensions: { orgSize: 3, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
      });

      const result = await runDiscovery({
        db,
        domainPack,
        config,
        screenshotDir: "runs/screenshots-test",
        browser,
        treelineAdapter: stubAdapter,
        disablePacing: true,
        random: () => 0,
        providerFactory: (_route, scheduled) => {
          if (scheduled.archetypeId === "p-success") {
            return new ScriptedModelProvider(
              [
                {
                  reasoning: "Go to the dashboard.",
                  actionType: "navigate",
                  url: `${site.baseUrl}/dashboard`,
                },
              ],
              0.01,
            );
          }
          if (scheduled.archetypeId === "p-hardstop") {
            // Unreachable host — fails fast (connection refused) rather than
            // timing out, exhausting patience=0's single retry
            // (maxRetries = round(1 + 0*4) = 1).
            return new ScriptedModelProvider(
              [
                {
                  reasoning: "Try an unreachable page.",
                  actionType: "navigate",
                  url: "http://127.0.0.1:1/",
                },
                { reasoning: "Try again.", actionType: "navigate", url: "http://127.0.0.1:1/" },
              ],
              0.01,
            );
          }
          // Deliberately just the console-error page, not also the fixture's
          // 500 endpoint — Chromium logs its own "Failed to load resource"
          // console error for a 500 response *in addition to* our tracked
          // http-failure event for it (see tests/actor/loop.test.ts's own
          // comment on this), which would make the exact finding count here
          // dependent on Chromium's own network-failure logging behavior
          // rather than on Drover's — not something a golden file should pin.
          return new ScriptedModelProvider(
            [
              {
                reasoning: "Visit the known-broken page.",
                actionType: "navigate",
                url: `${site.baseUrl}/broken`,
              },
              { reasoning: "Give up.", actionType: "finish", outcome: "gave-up" },
            ],
            0.01,
          );
        },
      });

      const dump = normalizeGolden(dumpRun(db, result), { baseUrl: site.baseUrl });
      expectMatchesGolden("mixed-outcomes", dump);
    },
    TIMEOUT,
  );

  it(
    "budget-stopped — the run ceiling cuts the schedule short, teardown still runs",
    async () => {
      db = new DroverDb(":memory:");
      let teardownCalls = 0;

      const domainPack: DomainPack = {
        appName: "golden-fixture-app",
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
        teardown: async () => {
          teardownCalls++;
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
        random: () => 0,
        providerFactory: () =>
          new ScriptedModelProvider(
            [{ reasoning: "Done.", actionType: "finish", outcome: "success" }],
            0.5,
          ),
      });

      expect(teardownCalls).toBe(1);
      const dump = normalizeGolden(dumpRun(db, result), { baseUrl: site.baseUrl });
      expectMatchesGolden("budget-stopped", dump);
    },
    TIMEOUT,
  );
});
