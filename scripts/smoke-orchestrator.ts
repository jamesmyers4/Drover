/**
 * Session 4 smoke script: exercises `drover run` as an actual CLI process
 * against the fixture site (or SMOKE_URL) — the orchestrator's "Done means"
 * bar from CLAUDE.md: a small config (2 personas x a few sessions) runs
 * sequentially end-to-end via CLI and produces a populated SQLite run.
 *
 * Generates a throwaway domain-pack.ts + sim.config.ts under runs/ (both
 * plain TS modules with a default export, loaded by the CLI itself — this
 * script never imports them directly) and spawns the CLI via tsx's own
 * bundled loader, the same way an installed `drover` binary would resolve
 * TS config files at runtime.
 *
 * Without ANTHROPIC_API_KEY, every persona-session's model call fails at
 * construction (see src/actor/provider.ts) and gets caught as a per-session
 * hard-stop by the orchestrator — the run still completes and the SQLite
 * file still ends up populated (run + session + hard-stop-finding rows),
 * which is a real exercise of the scheduling/budget/teardown/reconciliation
 * plumbing this session built, just not of real model behavior. Same
 * graceful-skip precedent as Session 2/3's staging-creds and API-key gaps.
 *
 *   npm run smoke:orchestrator
 *   SMOKE_URL=https://... npm run smoke:orchestrator
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DroverDb } from "../src/db/database.js";
import { startFixtureSite } from "../tests/fixtures/site.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function domainPackSource(): string {
  return `import type { DomainPack } from "../../src/types/index.js";

const domainPack: DomainPack = {
  appName: "Smoke Orchestrator Fixture",
  personas: [
    {
      id: "p1",
      name: "Reliable Rae",
      traits: { patience: 0.6, techSavviness: 0.5, deviceType: "desktop", familiarity: "new" },
    },
    {
      id: "p2",
      name: "Impatient Ivan",
      traits: { patience: 0.2, techSavviness: 0.3, deviceType: "mobile", familiarity: "new" },
    },
  ],
  goals: [
    {
      id: "sign-up-to-volunteer",
      description: "Sign up to volunteer, starting from the home page.",
      actionBudget: 6,
      checkpoints: [{ id: "on-signup", description: "On the signup page.", detector: "url:/signup" }],
      successCheckpointId: "on-signup",
    },
    {
      id: "browse-horses",
      description: "Browse the horse list from the home page.",
      actionBudget: 6,
      checkpoints: [{ id: "on-horses", description: "On the horses page.", detector: "url:/horses" }],
      successCheckpointId: "on-horses",
    },
  ],
  goalWeightsByPersona: {
    p1: [{ goalId: "sign-up-to-volunteer", weight: 1 }],
    p2: [{ goalId: "browse-horses", weight: 1 }],
  },
  dataPolicy: "synthetic-only",
  teardown: async (ctx) => {
    console.log(
      \`[teardown] wiping staging data created by run \${ctx.runId} against \${ctx.targetBaseUrl} (window: \${new Date(ctx.runStartedAt).toISOString()} - \${new Date(ctx.runEndedAt).toISOString()})\`,
    );
  },
};

export default domainPack;
`;
}

function simConfigSource(baseUrl: string): string {
  return `import type { SimConfig } from "../../src/types/index.js";

const config: SimConfig = {
  targetBaseUrl: ${JSON.stringify(baseUrl)},
  runDimensions: { orgSize: 2, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
  budget: { runCeilingUsd: 1, perSessionSoftCapUsd: 0.5 },
  modelRouting: {
    actor: { provider: "anthropic", model: "claude-haiku-4-5" },
    analyst: { provider: "anthropic", model: "claude-sonnet-5" },
  },
};

export default config;
`;
}

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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "Note: no ANTHROPIC_API_KEY set — every session's model call will fail fast and be " +
        "caught as a per-session hard-stop. This still exercises the full CLI/orchestrator " +
        "pipeline (scheduling, budget, teardown, reconciliation), just not real model behavior.\n",
    );
  }

  const externalUrl = process.env.SMOKE_URL;
  const site = externalUrl ? undefined : await startFixtureSite();
  const baseUrl = externalUrl ?? (site as { baseUrl: string }).baseUrl;

  const scratchDir = path.join(repoRoot, "runs", "smoke-orchestrator");
  mkdirSync(scratchDir, { recursive: true });
  const domainPackPath = path.join(scratchDir, "domain-pack.ts");
  const configPath = path.join(scratchDir, "sim.config.ts");
  const outPath = path.join(scratchDir, "run.sqlite");
  writeFileSync(domainPackPath, domainPackSource());
  writeFileSync(configPath, simConfigSource(baseUrl));

  console.log(`target: ${baseUrl}`);
  console.log(`domain pack: ${domainPackPath}`);
  console.log(`config: ${configPath}\n`);

  try {
    const { code, stdout } = await runCli([
      "run",
      domainPackPath,
      "--config",
      configPath,
      "--out",
      outPath,
    ]);
    if (code !== 0) {
      throw new Error(`drover run exited with code ${code}`);
    }

    const runIdMatch = /^Run ([0-9a-f-]+):/m.exec(stdout);
    if (!runIdMatch) {
      throw new Error("Could not find a run id in the CLI's output.");
    }
    const runId = runIdMatch[1] as string;

    const db = new DroverDb(outPath);
    try {
      const run = db.getRun(runId);
      const sessions = db.getSessionsByRun(runId);
      if (!run) throw new Error(`Run ${runId} not found in ${outPath}`);
      if (sessions.length === 0) throw new Error(`Run ${runId} has no session rows.`);
      console.log(
        `\nSQLite file populated: ${outPath} (run ${runId}, status ${run.status}, ${sessions.length} session(s))`,
      );
    } finally {
      db.close();
    }
  } finally {
    await site?.close();
    console.log(`Wrote ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
