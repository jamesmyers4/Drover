/**
 * Session 3 smoke script: one real LLM-driven persona-session end to end
 * against the fixture site (or SMOKE_URL) — the actor tier's "Done means"
 * bar from CLAUDE.md: events + reasoning land in SQLite, and an artificial
 * failure (an impossible checkpoint) produces an in-session finding with a
 * screenshot.
 *
 *   npm run smoke:actor                 # against the built-in fixture site
 *   SMOKE_URL=https://... npm run smoke:actor
 *
 * Requires ANTHROPIC_API_KEY (or an `ant auth login` profile) — skips
 * gracefully with an explanatory message if neither is configured, same
 * pattern as Session 2's staging-creds handling.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { SessionBudget } from "../src/actor/budget.js";
import { runPersonaSession } from "../src/actor/loop.js";
import { createModelProvider, DEFAULT_ACTOR_MODEL } from "../src/actor/provider.js";
import { BrowserSession, launchBrowser } from "../src/browser/index.js";
import { DroverDb, newId } from "../src/db/database.js";
import { createTreelineAdapter } from "../src/treeline/adapter.js";
import type { DomainPack, Goal, PersonaArchetype, SimConfig } from "../src/types/index.js";
import { startFixtureSite } from "../tests/fixtures/site.js";

const archetype: PersonaArchetype = {
  id: "first-timer-cautious",
  name: "Jamie",
  traits: { patience: 0.6, techSavviness: 0.4, deviceType: "desktop", familiarity: "new" },
};

const domainPack: Pick<DomainPack, "appName"> = { appName: "Fixture App" };

const signupGoal: Goal = {
  id: "sign-up-to-volunteer",
  description: "Sign up to volunteer, starting from the home page.",
  actionBudget: 8,
  checkpoints: [
    { id: "on-signup", description: "On the volunteer signup page.", detector: "url:/signup" },
    { id: "form-submitted", description: "Signup form submitted.", detector: "url:name=" },
  ],
  successCheckpointId: "form-submitted",
};

const impossibleGoal: Goal = {
  id: "impossible-checkpoint",
  description: "Find the (nonexistent) volunteer rewards dashboard.",
  actionBudget: 3,
  checkpoints: [
    {
      id: "unreachable",
      description: "A page that does not exist on this fixture site.",
      detector: "url:/this-page-does-not-exist",
    },
  ],
  successCheckpointId: "unreachable",
};

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "Skipping smoke-actor: no ANTHROPIC_API_KEY set. Export one (or run `ant auth login`) " +
        "to exercise the real Anthropic actor tier end to end.",
    );
    return;
  }

  const externalUrl = process.env.SMOKE_URL;
  const site = externalUrl ? undefined : await startFixtureSite();
  const baseUrl = externalUrl ?? (site as { baseUrl: string }).baseUrl;

  mkdirSync("runs", { recursive: true });
  const dbPath = path.join("runs", "smoke-actor.sqlite");
  const db = new DroverDb(dbPath);
  const screenshotDir = path.join("runs", "screenshots");

  const config: SimConfig = {
    targetBaseUrl: baseUrl,
    runDimensions: { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
    budget: { runCeilingUsd: 1, perSessionSoftCapUsd: 0.5 },
    modelRouting: {
      actor: { provider: "anthropic", model: DEFAULT_ACTOR_MODEL },
      analyst: { provider: "anthropic", model: "claude-sonnet-5" },
    },
  };

  const runId = newId();
  db.insertRun({
    id: runId,
    appName: "smoke-actor",
    config,
    status: "running",
    startedAt: Date.now(),
  });

  const treelineAdapter = await createTreelineAdapter();
  console.log(`treeLine adapter: ${treelineAdapter.kind}`);
  console.log(`target: ${baseUrl}`);
  console.log(`model: anthropic/${DEFAULT_ACTOR_MODEL}\n`);

  const browser = await launchBrowser();

  async function runOne(goal: Goal, label: string): Promise<void> {
    const sessionId = newId();
    db.insertSession({
      id: sessionId,
      runId,
      personaId: archetype.id,
      goalId: goal.id,
      status: "running",
      startedAt: Date.now(),
    });
    const browserSession = await BrowserSession.open(browser, {
      sessionId,
      db,
      deviceType: archetype.traits.deviceType,
    });
    await browserSession.navigate(`${baseUrl}/`, "Start at the home page.");

    console.log(`--- ${label} (session ${sessionId}) ---`);
    const result = await runPersonaSession({
      db,
      browserSession,
      browser,
      sessionId,
      provider: createModelProvider(config.modelRouting.actor),
      archetype,
      domainPack,
      goal,
      treelineAdapter,
      targetBaseUrl: baseUrl,
      budget: new SessionBudget(config.budget.perSessionSoftCapUsd),
      screenshotDir,
    });
    db.updateSessionStatus(sessionId, result.status, Date.now());
    await browserSession.close();

    console.log(`status: ${result.status}, succeeded: ${result.succeeded}`);
    console.log(`actions taken: ${result.actionsTaken}/${goal.actionBudget}`);
    console.log(`reached checkpoints: ${result.reachedCheckpointIds.join(", ") || "(none)"}`);
    console.log(`cost: $${result.totalCostUsd.toFixed(4)}`);
    const findings = db.getInSessionFindingsBySession(sessionId);
    console.log(
      `in-session findings: ${findings.length} (${findings.map((f) => f.type).join(", ") || "none"})`,
    );
    for (const f of findings) {
      if (f.screenshotPath) console.log(`  ${f.type} screenshot: ${f.screenshotPath}`);
    }
    console.log();
  }

  try {
    await runOne(signupGoal, "Real goal: sign up to volunteer");
    await runOne(impossibleGoal, "Artificial failure: impossible checkpoint");
    db.updateRunStatus(runId, "completed", Date.now());
  } catch (err) {
    db.updateRunStatus(runId, "crashed", Date.now());
    throw err;
  } finally {
    await browser.close();
    await site?.close();
    db.close();
    console.log(`Wrote run ${runId} to ${dbPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
