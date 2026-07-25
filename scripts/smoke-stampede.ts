/**
 * Session 7 smoke script: exercises `drover stampede` as an actual CLI
 * process against the fixture site (or SMOKE_URL) — Stampede's "Done means"
 * bar: given a completed discovery run's recorded routes, a real subprocess
 * replays them at increasing concurrency and writes per-route percentile/
 * error rows. Also runs `drover report` afterward and checks its stdout for
 * the "Load test results (Stampede)" section (GAPS.md: folding Stampede
 * results into the report), since this is the one place a real CLI
 * subprocess chain proves the two commands actually compose end to end.
 *
 * Unlike every other smoke script, this one needs no ANTHROPIC_API_KEY at
 * all — Stampede has no LLM calls anywhere in it (CONTEXT.md: "no reasoning,
 * just volume"). The fixture "discovery run" it replays is built directly
 * via DroverDb (same precedent as smoke-analyst.ts), not via a real
 * `drover run` CLI invocation, since that would need a model to actually
 * choose actions — a hand-built run with a few `navigate` events is exactly
 * as good a source of "discovered routes" for this script's purposes.
 *
 *   npm run smoke:stampede
 *   SMOKE_URL=https://... npm run smoke:stampede
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DroverDb, newId } from "../src/db/database.js";
import type { PersonaSession, Run, SimConfig } from "../src/types/index.js";
import { startFixtureSite } from "../tests/fixtures/site.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, "src/cli/index.ts", ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function main(): Promise<void> {
  const externalUrl = process.env.SMOKE_URL;
  const site = externalUrl ? undefined : await startFixtureSite();
  const baseUrl = externalUrl ?? (site as { baseUrl: string }).baseUrl;

  const scratchDir = path.join(repoRoot, "runs", "smoke-stampede");
  mkdirSync(scratchDir, { recursive: true });
  const dbPath = path.join(scratchDir, "run.sqlite");

  const config: SimConfig = {
    targetBaseUrl: baseUrl,
    runDimensions: { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
    budget: { runCeilingUsd: 1, perSessionSoftCapUsd: 1 },
    modelRouting: {
      actor: { provider: "scripted", model: "scripted" },
      analyst: { provider: "scripted", model: "scripted" },
    },
  };

  const sourceRunId = newId();
  const db = new DroverDb(dbPath);
  const sourceRun: Run = {
    id: sourceRunId,
    appName: "smoke-stampede",
    config,
    status: "completed",
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
  };
  db.insertRun(sourceRun);

  const session: PersonaSession = {
    id: newId(),
    runId: sourceRunId,
    personaId: "impatient-rushed",
    goalId: "browse",
    status: "completed",
    startedAt: Date.now() - 50_000,
    endedAt: Date.now() - 40_000,
  };
  db.insertSession(session);
  for (const route of ["/", "/horses", "/api/horses/page2"]) {
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: Date.now() - 45_000,
      actionType: "navigate",
      target: `${baseUrl}${route}`,
      reasoning: "Discovered during a prior fixture discovery run.",
    });
  }
  db.close();

  console.log(`target: ${baseUrl}`);
  console.log(`source run: ${sourceRunId} (3 discovered routes)\n`);

  try {
    const { code, stdout } = await runCli([
      "stampede",
      sourceRunId,
      "--db",
      dbPath,
      "--concurrency",
      "1,3",
      "--iterations-per-worker",
      "2",
    ]);
    if (code !== 0) {
      throw new Error(`drover stampede exited with code ${code}`);
    }

    const stampedeRunIdMatch = /^Stampede run ([0-9a-f-]+) against/m.exec(stdout);
    if (!stampedeRunIdMatch) {
      throw new Error("Could not find a stampede run id in the CLI's output.");
    }
    const stampedeRunId = stampedeRunIdMatch[1] as string;

    const verifyDb = new DroverDb(dbPath);
    try {
      const results = verifyDb.getStampedeRouteResultsByRun(stampedeRunId);
      // 3 routes x 2 concurrency levels = 6 (route, concurrency) rows.
      if (results.length !== 6) {
        throw new Error(`Expected 6 stampede result rows, got ${results.length}.`);
      }
      const errorRoute = results.find((r) => r.route === "/api/horses/page2");
      if (!errorRoute || errorRoute.errorCount === 0) {
        throw new Error("Expected the fixture's 500 route to show a non-zero error count.");
      }
      console.log(`\nVerified ${results.length} stampede result rows in ${dbPath}.`);
    } finally {
      verifyDb.close();
    }

    const reportResult = await runCli(["report", sourceRunId, "--db", dbPath]);
    if (reportResult.code !== 0) {
      throw new Error(`drover report exited with code ${reportResult.code}`);
    }
    if (!reportResult.stdout.includes("## Load test results (Stampede)")) {
      throw new Error("drover report's output did not include the Stampede results section.");
    }
    if (!reportResult.stdout.includes(stampedeRunId)) {
      throw new Error("drover report's Stampede section did not reference this stampede run id.");
    }
    console.log("Verified drover report folds this stampede run's results in.");
  } finally {
    await site?.close();
    console.log(`Wrote ${dbPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
