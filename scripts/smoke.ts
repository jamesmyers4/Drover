/**
 * Session 2 smoke script: drives a hardcoded action sequence through the
 * BrowserSession wrapper and writes real rows to SQLite. No LLM involved.
 *
 *   npm run smoke                 # runs against the built-in local fixture site
 *   SMOKE_URL=https://... npm run smoke   # generic sequence against any URL
 *
 * Output: runs/smoke.sqlite (one new run+session per invocation) and a
 * printed event summary.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { BrowserSession, launchBrowser } from "../src/browser/index.js";
import { captureScreenshot } from "../src/browser/screenshot.js";
import { DroverDb, newId } from "../src/db/database.js";
import { createTreelineAdapter } from "../src/treeline/adapter.js";
import type { SimConfig } from "../src/types/index.js";
import { startFixtureSite } from "../tests/fixtures/site.js";

async function main(): Promise<void> {
  const externalUrl = process.env.SMOKE_URL;
  const site = externalUrl ? undefined : await startFixtureSite();
  const baseUrl = externalUrl ?? (site as { baseUrl: string }).baseUrl;

  mkdirSync("runs", { recursive: true });
  const dbPath = path.join("runs", "smoke.sqlite");
  const db = new DroverDb(dbPath);

  const config: SimConfig = {
    targetBaseUrl: baseUrl,
    runDimensions: { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
    budget: { runCeilingUsd: 0, perSessionSoftCapUsd: 0 },
    modelRouting: {
      actor: { provider: "none", model: "scripted-smoke" },
      analyst: { provider: "none", model: "scripted-smoke" },
    },
  };

  const runId = newId();
  const sessionId = newId();
  db.insertRun({
    id: runId,
    appName: "smoke",
    config,
    status: "running",
    startedAt: Date.now(),
  });
  db.insertSession({
    id: sessionId,
    runId,
    personaId: "smoke-scripted",
    goalId: "smoke-sequence",
    status: "running",
    startedAt: Date.now(),
  });

  const adapter = await createTreelineAdapter();
  console.log(`treeLine adapter: ${adapter.kind}`);
  console.log(`target: ${baseUrl}`);

  const browser = await launchBrowser();
  const session = await BrowserSession.open(browser, { sessionId, db, deviceType: "desktop" });

  try {
    if (externalUrl) {
      await session.navigate(baseUrl, "Open the smoke target's landing page.");
      const state = await session.readPageState("Take stock of what the landing page offers.");
      console.log(`page title: ${state.title}`);
      const authWalled = await adapter.detectAuthWall(session.page);
      console.log(`auth wall detected: ${authWalled}`);
    } else {
      await session.navigate(`${baseUrl}/`, "Start at the home page like a first-time visitor.");
      await session.readPageState("Look over the home page to find where to go.");
      await session.click("#nav-horses", "The horses link looks like the main content.");
      await session.click("#load-more", "Try to see more horses than the first three.");
      await session.navigate(`${baseUrl}/broken`, "Visit the known-broken page to observe errors.");
      await session.navigate(`${baseUrl}/signup`, "Head to signup to try volunteering.");
      await session.fill("#signup-name", "Smoke Tester", "Enter a name to sign up with.");
      await session.fill("#signup-email", "smoke@example.com", "Enter a contact email.");
      await session.click("#signup-submit", "Submit the completed signup form.");
      await session.readPageState("Confirm where submitting the form landed.");
      await session.navigate(`${baseUrl}/login`, "Check what logging in would involve.");
      const authWalled = await adapter.detectAuthWall(session.page);
      console.log(`auth wall detected on /login: ${authWalled}`);
    }

    const shot = await captureScreenshot(session.page, path.join("runs", "screenshots"), "smoke-final");
    if (shot) console.log(`screenshot: ${shot}`);

    db.updateSessionStatus(sessionId, "completed", Date.now());
    db.updateRunStatus(runId, "completed", Date.now());
  } catch (err) {
    db.updateSessionStatus(sessionId, "hard-stopped", Date.now());
    db.updateRunStatus(runId, "crashed", Date.now());
    throw err;
  } finally {
    await session.close();
    await browser.close();
    await site?.close();

    const events = db.getEventsBySession(sessionId);
    const byType = new Map<string, number>();
    for (const e of events) byType.set(e.actionType, (byType.get(e.actionType) ?? 0) + 1);
    console.log(`\n${events.length} events written to ${dbPath} (session ${sessionId}):`);
    for (const [type, count] of [...byType.entries()].sort()) {
      console.log(`  ${type}: ${count}`);
    }
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
