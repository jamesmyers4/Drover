#!/usr/bin/env node
/**
 * `drover run <domain-pack> [--config sim.config.ts]` (CLAUDE.md Session 4).
 * Domain packs and sim configs are local TypeScript modules with a default
 * export — loading them at runtime (whether this CLI is running under `tsx`
 * in dev or as plain compiled JS once installed) needs a TS-aware ESM loader
 * registered first, hence the `tsx/esm/api` register() call before either
 * dynamic import happens.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { DEFAULT_SESSIONS_PER_CHUNK, runAnalyst } from "../analyst/analyze.js";
import { DroverDb } from "../db/database.js";
import { loadDefaultExport } from "../orchestrator/config-loader.js";
import { runDiscovery } from "../orchestrator/run-discovery.js";
import type { DomainPack, SimConfig } from "../types/index.js";

async function registerTsLoader(): Promise<void> {
  try {
    const { register } = await import("tsx/esm/api");
    register();
  } catch {
    // Already registered in this process (e.g. the CLI itself was launched
    // via `tsx`) — dynamic .ts imports already work, nothing more to do.
  }
}

async function runCommand(
  domainPackPath: string,
  options: { config: string; out?: string },
): Promise<void> {
  await registerTsLoader();

  const domainPack = await loadDefaultExport<DomainPack>(domainPackPath, "domain pack");
  const config = await loadDefaultExport<SimConfig>(options.config, "sim config");

  const outPath = options.out ?? path.join("runs", `${Date.now()}.sqlite`);
  mkdirSync(path.dirname(outPath) || ".", { recursive: true });
  const screenshotDir = path.join(path.dirname(outPath) || "runs", "screenshots");

  console.log(`Running "${domainPack.appName}"`);
  console.log(`  dimensions: ${JSON.stringify(config.runDimensions)}`);
  console.log(
    `  budget: $${config.budget.runCeilingUsd} run ceiling, $${config.budget.perSessionSoftCapUsd} per-session soft cap`,
  );
  console.log(`  target: ${config.targetBaseUrl}\n`);

  const db = new DroverDb(outPath);
  try {
    const result = await runDiscovery({ db, domainPack, config, screenshotDir });

    console.log(`Run ${result.runId}: ${result.status}`);
    console.log(`  sessions scheduled:     ${result.sessionsScheduled}`);
    console.log(`  sessions completed:     ${result.sessionsCompleted}`);
    console.log(`  sessions hard-stopped:  ${result.sessionsHardStopped}`);
    console.log(`  sessions budget-capped: ${result.sessionsBudgetCapped}`);
    console.log(`  sessions errored:       ${result.sessionsErrored}`);
    console.log(`  total cost:             $${result.totalCostUsd.toFixed(4)}`);
    console.log(
      `  findings vs. prior runs: ${result.reconciliation.new} new, ${result.reconciliation.stillOpen} still open, ${result.reconciliation.resolved} resolved`,
    );
    console.log(`  db: ${outPath}`);
  } finally {
    db.close();
  }
}

async function analyzeCommand(
  runId: string,
  options: { db: string; pollIntervalMs: string; sessionsPerChunk: string },
): Promise<void> {
  const db = new DroverDb(options.db);
  try {
    const run = db.getRun(runId);
    if (!run) {
      throw new Error(`No run found with id "${runId}" in "${options.db}".`);
    }

    console.log(`Analyzing run ${runId} ("${run.appName}")`);
    if (run.config.budget.analystCeilingUsd !== undefined) {
      console.log(`  analyst ceiling: $${run.config.budget.analystCeilingUsd}`);
    }
    const result = await runAnalyst({
      db,
      runId,
      pollIntervalMs: Number(options.pollIntervalMs),
      sessionsPerChunk: Number(options.sessionsPerChunk),
    });

    console.log(`  sessions analyzed:  ${result.sessionsAnalyzed}`);
    console.log(`  findings written:   ${result.findingsWritten}`);
    console.log(`  findings skipped:   ${result.findingsSkipped}`);
    for (const reason of result.skippedReasons) console.log(`    - ${reason}`);
    console.log(
      `  findings vs. prior runs: ${result.reconciliation.new} new, ${result.reconciliation.stillOpen} still open, ${result.reconciliation.resolved} resolved`,
    );
    console.log(`  cost: $${result.costUsd.toFixed(4)}`);
  } finally {
    db.close();
  }
}

const program = new Command();
program
  .name("drover")
  .description("Config-driven simulation harness that runs AI-driven personas through a web app.");

program
  .command("run")
  .description("Run discovery mode against a domain pack.")
  .argument("<domain-pack>", "path to a .ts module exporting a DomainPack as its default export")
  .option("-c, --config <path>", "path to a sim.config.ts module", "sim.config.ts")
  .option("-o, --out <path>", "SQLite output file path (default: runs/<timestamp>.sqlite)")
  .action(async (domainPackPath: string, options: { config: string; out?: string }) => {
    try {
      await runCommand(domainPackPath, options);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("analyze")
  .description(
    "Run the analyst tier (cross-session pattern mining) on a completed run. Separate from `run` so a run can be re-analyzed without re-simulating.",
  )
  .argument("<run-id>", "id of a previously completed run")
  .requiredOption(
    "-d, --db <path>",
    "path to the run's SQLite file (the --out path from `drover run`)",
  )
  .option("--poll-interval-ms <ms>", "Batch API polling interval in milliseconds", "5000")
  .option(
    "--sessions-per-chunk <n>",
    "max sessions per analyst request — splits a large run across multiple concurrent requests",
    String(DEFAULT_SESSIONS_PER_CHUNK),
  )
  .action(
    async (
      runId: string,
      options: { db: string; pollIntervalMs: string; sessionsPerChunk: string },
    ) => {
      try {
        await analyzeCommand(runId, options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    },
  );

program.parseAsync(process.argv);
