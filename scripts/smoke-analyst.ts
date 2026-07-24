/**
 * Session 5 smoke script: one real analyst-tier run against fixture session
 * data — the analyst's "Done means" bar from CLAUDE.md: `drover analyze` on
 * a real run writes cross-session findings with correct session references.
 *
 * Builds a small SQLite run directly (three sessions that all independently
 * stumble on the same route — a `repeated-stumble-route` pattern deliberate
 * enough for a real model call to actually find) rather than depending on a
 * prior `smoke:orchestrator` run, so this script has no dependency on
 * ANTHROPIC_API_KEY being set for the *actor* tier too.
 *
 *   npm run smoke:analyst
 *
 * Requires ANTHROPIC_API_KEY (or an `ant auth login` profile) — skips
 * gracefully with an explanatory message if neither is configured, same
 * pattern as Session 3/4's staging-creds/API-key handling. Note: real Batch
 * API requests can take anywhere from under a minute to (per Anthropic's
 * docs) up to 24 hours to complete — this script polls until done with no
 * timeout of its own.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { runAnalyst } from "../src/analyst/analyze.js";
import { DroverDb, newId } from "../src/db/database.js";
import type { PersonaSession, Run, SimConfig } from "../src/types/index.js";

const POLL_INTERVAL_MS = 5000;

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "Skipping smoke-analyst: no ANTHROPIC_API_KEY set. Export one (or run `ant auth login`) " +
        "to exercise the real Sonnet Batch API analyst tier end to end.",
    );
    return;
  }

  mkdirSync("runs", { recursive: true });
  const dbPath = path.join("runs", "smoke-analyst.sqlite");
  const db = new DroverDb(dbPath);

  const config: SimConfig = {
    targetBaseUrl: "https://staging.example.test",
    runDimensions: { orgSize: 3, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
    budget: { runCeilingUsd: 1, perSessionSoftCapUsd: 0.5 },
    modelRouting: {
      actor: { provider: "anthropic", model: "claude-haiku-4-5" },
      analyst: { provider: "anthropic", model: "claude-sonnet-5" },
    },
  };

  const runId = newId();
  const run: Run = {
    id: runId,
    appName: "smoke-analyst",
    config,
    status: "completed",
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
  };
  db.insertRun(run);

  // Three independent personas each try to save a feeding-schedule edit and
  // get stuck at the same point — a deliberate repeated-stumble-route
  // pattern for the real model to find.
  const personas = ["impatient-rushed", "first-timer-cautious", "power-user-mobile"];
  const sessions: PersonaSession[] = personas.map((personaId, i) => {
    const session: PersonaSession = {
      id: newId(),
      runId,
      personaId,
      goalId: "adjust-feeding-schedule",
      status: "hard-stopped",
      startedAt: Date.now() - 50_000 + i * 1000,
      endedAt: Date.now() - 40_000 + i * 1000,
    };
    db.insertSession(session);

    const t0 = session.startedAt;
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: t0 + 200,
      actionType: "navigate",
      target: "/schedule/edit",
      reasoning: "Heading to the feeding schedule to make the edit.",
    });
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: t0 + 1800,
      actionType: "click",
      target: "#save-schedule",
      reasoning: "Clicking Save to submit the updated schedule.",
    });
    const failureEventId = db.insertActionEvent({
      sessionId: session.id,
      timestamp: t0 + 2100,
      actionType: "http-failure",
      target: "500 POST https://staging.example.test/api/schedule",
      reasoning: "The save request came back as a server error.",
    });
    db.insertInSessionFinding({
      id: newId(),
      sessionId: session.id,
      eventId: failureEventId,
      type: "http-failure",
      severity: "high",
      description: "HTTP 500 response observed: 500 POST https://staging.example.test/api/schedule",
      matchKey: "http-failure:/api/schedule:POST",
      createdAt: t0 + 2100,
    });

    return session;
  });

  console.log(`target run: ${runId} ("${run.appName}"), ${sessions.length} fixture session(s)`);
  console.log(`model: anthropic/${config.modelRouting.analyst.model} (Batch API)`);
  console.log("Polling until the batch completes — this may take a little while...\n");

  try {
    const result = await runAnalyst({ db, runId, pollIntervalMs: POLL_INTERVAL_MS });

    console.log(`sessions analyzed: ${result.sessionsAnalyzed}`);
    console.log(`findings written:  ${result.findingsWritten}`);
    console.log(`findings skipped:  ${result.findingsSkipped}`);
    for (const reason of result.skippedReasons) console.log(`  - ${reason}`);
    console.log(
      `reconciliation: ${result.reconciliation.new} new, ${result.reconciliation.stillOpen} still open, ${result.reconciliation.resolved} resolved`,
    );
    console.log(`cost: $${result.costUsd.toFixed(4)}`);

    for (const finding of db.getCrossSessionFindingsByRun(runId)) {
      console.log(`\n[${finding.type}] (${finding.severity}) ${finding.description}`);
      console.log(`  sessions: ${finding.sessionIds.join(", ")}`);
      console.log(`  matchKey: ${finding.matchKey}`);
    }
  } finally {
    db.close();
    console.log(`\nWrote run ${runId} to ${dbPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
