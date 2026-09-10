#!/usr/bin/env node
/**
 * `drover run <domain-pack> [--config sim.config.ts]` (CLAUDE.md Session 4).
 * Domain packs and sim configs are local TypeScript modules with a default
 * export — loading them at runtime (whether this CLI is running under `tsx`
 * in dev or as plain compiled JS once installed) needs a TS-aware ESM loader
 * registered first, hence the `tsx/esm/api` register() call before either
 * dynamic import happens.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { DEFAULT_SESSIONS_PER_CHUNK, runAnalyst } from "../analyst/analyze.js";
import { DroverDb } from "../db/database.js";
import { buildGraderCiSummary } from "../grader/ci-summary.js";
import { GraderDb } from "../grader/db.js";
import type { GraderModelRouting } from "../grader/grade.js";
import { runGrading } from "../grader/grade.js";
import { DEFAULT_GRADER_OLLAMA_MODEL, DEFAULT_HOSTED_GRADER_MODEL } from "../grader/provider.js";
import { buildGradingReport } from "../grader/report.js";
import { renderGradingReportMarkdown } from "../grader/report-markdown.js";
import type { GraderPack } from "../grader/types.js";
import { loadDefaultExport } from "../orchestrator/config-loader.js";
import { runDiscovery } from "../orchestrator/run-discovery.js";
import { buildRunReport, renderMarkdownReport } from "../report/index.js";
import { SoakDb } from "../soak/db.js";
import { runSoak } from "../soak/scheduler.js";
import type { SoakBlueprint } from "../soak/types.js";
import {
  DEFAULT_CONCURRENCY_LEVELS,
  DEFAULT_ITERATIONS_PER_WORKER,
  runStampede,
} from "../stampede/index.js";
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
    const result = await runDiscovery({
      db,
      domainPack,
      config,
      screenshotDir,
    });

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

async function reportCommand(runId: string, options: { db: string; out?: string }): Promise<void> {
  const db = new DroverDb(options.db);
  try {
    const report = buildRunReport(db, runId);
    const markdown = renderMarkdownReport(report);
    if (options.out) {
      mkdirSync(path.dirname(options.out) || ".", { recursive: true });
      writeFileSync(options.out, markdown);
      console.log(`Report written to ${options.out}`);
    } else {
      console.log(markdown);
    }
  } finally {
    db.close();
  }
}

function parseConcurrencyLevels(raw: string): number[] {
  const levels = raw.split(",").map((s) => Number(s.trim()));
  for (const level of levels) {
    if (!Number.isInteger(level) || level < 1) {
      throw new Error(
        `--concurrency must be a comma-separated list of positive integers, got "${raw}".`,
      );
    }
  }
  return levels;
}

async function stampedeCommand(
  sourceRunId: string,
  options: { db: string; concurrency: string; iterationsPerWorker: string },
): Promise<void> {
  const db = new DroverDb(options.db);
  try {
    const concurrencyLevels = parseConcurrencyLevels(options.concurrency);
    const iterationsPerWorker = Number(options.iterationsPerWorker);

    console.log(`Stampede-replaying routes discovered by run ${sourceRunId}`);
    console.log(`  concurrency levels: ${concurrencyLevels.join(", ")}`);
    console.log(`  iterations/worker:  ${iterationsPerWorker}\n`);

    const result = await runStampede({
      db,
      sourceRunId,
      concurrencyLevels,
      iterationsPerWorker,
    });

    console.log(`Stampede run ${result.stampedeRunId} against ${result.targetBaseUrl}`);
    console.log(`  routes: ${result.routes.join(", ")}\n`);
    console.log(
      `  ${"route".padEnd(30)}${"conc".padEnd(6)}${"samples".padEnd(9)}${"errors".padEnd(8)}${"p50".padEnd(8)}${"p95".padEnd(8)}p99`,
    );
    for (const r of result.results) {
      console.log(
        `  ${r.route.padEnd(30)}${String(r.concurrency).padEnd(6)}${String(r.sampleCount).padEnd(9)}${String(r.errorCount).padEnd(8)}${`${r.p50Ms}ms`.padEnd(8)}${`${r.p95Ms}ms`.padEnd(8)}${r.p99Ms}ms`,
      );
    }
  } finally {
    db.close();
  }
}

/**
 * `drover grade <pack> [--db path]` (FUTUREPLAN.md Grader Session 2, wired
 * for real in Session 3). `runGradingRun` (`scheduler.ts`) validates the
 * pack internally — before anything would spend real work dispatching
 * Tasks against it, and before any `grading_runs` row is inserted, so a
 * malformed pack never leaves a "crashed" row behind for a grading run that
 * never actually started. There's no separate pre-validation call here
 * (Session 3 used to have one): a second call would mean calling
 * `pack.loadCases()` twice, which `validateGraderPack`'s doc comment
 * explains is a real correctness risk for a stateful adapter, not just
 * redundant work.
 *
 * `--db` always resolves to a real path — defaulting to a single, stable
 * `grader.sqlite` in the current directory (Q6's own naming) when omitted,
 * *not* a fresh timestamped file per invocation the way `runCommand`'s
 * `--out` defaults for `drover run`. That precedent doesn't actually
 * transfer: `--out`'s default names a *report* artifact, which correctly
 * wants a unique path per run, but here it would be naming the *database*
 * itself, and `grading_runs` is meant to accumulate history the way
 * `Session 6`'s report and the deferred Layer 8 both depend on being able
 * to read (compare this run against prior ones). A fresh file per
 * invocation would make that structurally impossible by default — and this
 * isn't hypothetical: Drover's own `runs/` directory already shows the
 * failure mode for real (`hhops-drover-container-1/2/3.sqlite`, three
 * separate files from three real runs of the same domain pack, so
 * cross-run reconciliation between them never actually ran, since
 * `reconcile.ts`'s "prior runs" query only ever sees rows in the file
 * that's actually open). A bare `drover grade <pack>` therefore reuses the
 * same file across invocations by default — real accumulated history,
 * not scattered timestamped snapshots — with `--db` reserved for a
 * deliberate override (a scratch run, a CI-specific path). Either way,
 * there's no "validate-only, nothing persisted" mode to silently fall into
 * by forgetting a flag.
 *
 * **Exit-code contract (FUTUREPLAN.md Grader Session 7; ADR 0005).** A
 * nonzero exit means the Grading Run itself didn't complete — a pack that
 * fails `validateGraderPack`, or a genuine orchestration-level fault
 * (`runGradingRun`'s `crashed` path) — both already propagate as a thrown
 * error into the top-level `.action()` catch below, which sets
 * `process.exitCode = 1`; no separate logic was needed to "add" this
 * contract, only to make it deliberate rather than incidental. This is
 * deliberately *not* a content-quality gate: whether any Case's Checks
 * passed, failed, or needed escalation never changes the exit code, since
 * ADR 0005 left the fail-threshold policy (what a CI gate should treat as
 * "this run failed") explicitly open — see `docs/GRADER-CI.md`. A consuming
 * CI workflow makes that call itself by parsing `--json`'s output, not by
 * reading this tool's exit code as a proxy for it.
 */
/**
 * Default `GraderModelRouting` for a bare `drover grade` invocation with no
 * routing override. Layers 2-3 always dispatch to the local Ollama model
 * (`DEFAULT_GRADER_OLLAMA_MODEL`) — the "$0 by design" routine-work judge
 * (FUTUREPLAN.md's cost-basis note).
 *
 * Layers 4-7 (multi-judge Consensus Round) need >= 2 distinct-model-family
 * judges plus an escalation route (ADR 0003) — this build environment (like
 * most fresh installs) has only one local model pulled, so the second judge
 * comes from Anthropic instead, *when it's actually usable*: an
 * `ANTHROPIC_API_KEY` is present in the environment, and the pack's own
 * `dataPolicy`/`allowHostedEscalation` would allow a hosted dispatch in the
 * first place (mirrors `assertHostedGraderDispatchAllowed`'s own rule,
 * checked here rather than by catching its throw, so an unusable pack
 * degrades to "just Layers 1-3" the same graceful way as having no second
 * judge at all — never a crashed `drover grade` invocation over the CLI's
 * own default choice). Ollama does the routine per-Case judging (one of the
 * two Consensus votes, alongside Layers 2-3's single-judge work); Anthropic
 * (`DEFAULT_HOSTED_GRADER_MODEL`) supplies the second, independent vote and
 * doubles as the escalation adjudicator — a real second opinion from the
 * paid model specifically when the two disagree, not a per-Case cost.
 * Escalation is the rare path (Q10) — this keeps real dollar spend small by
 * design, matching the "Ollama does the work, Anthropic is a second-stage
 * check" split the user asked for. When neither condition holds, Layers 4-7
 * are left out entirely (a console warning, not an error) — see
 * GAPS.md's 2026-09-09 entries for the fuller history of this gap.
 */
function defaultGraderRouting(
  pack: Pick<GraderPack, "dataPolicy" | "allowHostedEscalation">,
): GraderModelRouting {
  const ollamaJudge = { provider: "ollama", model: DEFAULT_GRADER_OLLAMA_MODEL };
  const hostedDispatchAllowed =
    pack.dataPolicy !== "restricted" || pack.allowHostedEscalation === true;
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);

  if (!hostedDispatchAllowed || !hasAnthropicKey) {
    return { singleJudge: ollamaJudge, consensusJudges: [] };
  }

  const anthropicJudge = { provider: "anthropic", model: DEFAULT_HOSTED_GRADER_MODEL };
  return {
    singleJudge: ollamaJudge,
    consensusJudges: [ollamaJudge, anthropicJudge],
    escalation: anthropicJudge,
  };
}

async function gradeCommand(
  packPath: string,
  options: { db?: string; report?: string; json?: string | boolean },
): Promise<void> {
  await registerTsLoader();

  const pack = await loadDefaultExport<GraderPack>(packPath, "GraderPack");
  const dbPath = options.db ?? "grader.sqlite";
  mkdirSync(path.dirname(dbPath) || ".", { recursive: true });

  const routing = defaultGraderRouting(pack);
  console.log(`Grading "${pack.appName}"`);
  console.log(`  dataPolicy:            ${pack.dataPolicy}`);
  console.log(`  allowHostedEscalation: ${pack.allowHostedEscalation ?? false}`);
  console.log(
    `  layer 2-3 judge:       ${routing.singleJudge.provider}:${routing.singleJudge.model}`,
  );
  console.log(
    `  layer 4-7 judges:      ${routing.consensusJudges.map((r) => `${r.provider}:${r.model}`).join(", ") || "none"}`,
  );
  console.log(`  db:                    ${dbPath}\n`);

  const db = new GraderDb(dbPath);
  try {
    const result = await runGrading({ db, pack, routing });
    console.log(`Grading run ${result.gradingRunId}: ${result.status}`);
    console.log(`  cases processed:        ${result.casesProcessed}`);
    console.log(`  tasks passed:           ${result.tasksPassed}`);
    console.log(`  tasks failed:           ${result.tasksFailed}`);
    console.log(`  tasks skipped:          ${result.tasksSkipped}`);
    console.log(`  layers 4-7 enabled:     ${result.consensusLayersEnabled.join(", ") || "none"}`);

    const report = buildGradingReport(db, result.gradingRunId);
    const markdown = renderGradingReportMarkdown(report);
    if (options.report) {
      mkdirSync(path.dirname(options.report) || ".", { recursive: true });
      writeFileSync(options.report, markdown);
      console.log(`\nGrading report written to ${options.report}`);
    } else {
      console.log(`\n${markdown}`);
    }

    // The CI JSON summary (ADR 0005) is opt-in via `--json` — unlike the
    // markdown report above, it's not printed by default, since it's a
    // machine-facing artifact a human running this interactively has no use
    // for cluttering their terminal with. `--json` alone (no path) prints
    // it to stdout instead, same "path optional, defaults to stdout"
    // precedent `--report`/`drover report`'s `--out` already established.
    if (options.json !== undefined) {
      const summary = buildGraderCiSummary(report);
      const json = JSON.stringify(summary, null, 2);
      if (typeof options.json === "string") {
        mkdirSync(path.dirname(options.json) || ".", { recursive: true });
        writeFileSync(options.json, json);
        console.log(`CI JSON summary written to ${options.json}`);
      } else {
        console.log(json);
      }
    }
  } finally {
    db.close();
  }
}

/**
 * `drover soak run <blueprint> [--db path]` (CTS.md Soak Session 2, wired
 * for real in Session 3 — closing Session 2's own "not yet opened or
 * written" breadcrumb, same precedent Grader Session 3 set for `drover
 * grade`'s `--db` flag). `runSoak` (`scheduler.ts`) validates the blueprint
 * internally before inserting any `soak_runs` row, so a malformed blueprint
 * never leaves a "crashed" row behind for a run that never actually started
 * — same guarantee `runGradingRun` already established for Grader.
 *
 * `--db` defaults to a single, stable `soak.sqlite` in the current directory
 * — the same "reused across invocations, not a fresh timestamped file per
 * run" precedent `gradeCommand` already established for `grader.sqlite`,
 * deliberately applied here from the start rather than relearned the way
 * Grader Session 3 had to relearn it (see that session's status note on
 * `runs/hhops-drover-container-1/2/3.sqlite`'s cross-run-reconciliation
 * fragmentation).
 *
 * The bearer token for HTTP dispatch is read from `SOAK_AUTH_TOKEN` here,
 * at the CLI boundary, and passed through as a `runSoak` option — never
 * placed on the blueprint itself, since `SoakBlueprint` gets persisted
 * (minus `teardown`) into `soak_runs.blueprint_config_json` and a secret
 * has no business entering that snapshot (the same "secrets stay in the
 * orchestrator's HTTP layer only" discipline `DomainPack.auth` already
 * follows for the simulation stack).
 */
async function soakRunCommand(blueprintPath: string, options: { db?: string }): Promise<void> {
  await registerTsLoader();

  const blueprint = await loadDefaultExport<SoakBlueprint>(blueprintPath, "SoakBlueprint");
  const dbPath = options.db ?? "soak.sqlite";
  mkdirSync(path.dirname(dbPath) || ".", { recursive: true });

  console.log(`Soak blueprint "${blueprint.appName}" v${blueprint.version}`);
  console.log(`  dataPolicy: ${blueprint.dataPolicy}`);
  console.log(`  driver:     ${blueprint.driverProvider}/${blueprint.driverModel}`);
  console.log(`  target:     ${blueprint.targetBaseUrl}`);
  console.log(`  budget:     $${blueprint.budget.ceilingUsd} run ceiling`);
  console.log(`  db:         ${dbPath}\n`);

  const db = new SoakDb(dbPath);
  try {
    const authToken = process.env.SOAK_AUTH_TOKEN;
    const result = await runSoak({ db, blueprint, ...(authToken !== undefined && { authToken }) });
    console.log(`Soak run ${result.runId}: ${result.status}`);
    console.log(`  turns dispatched:  ${result.turnsDispatched}`);
    console.log(`  explicit errors:   ${result.explicitErrorCount}`);
    console.log(`  gated responses:   ${result.gatedResponseCount}`);
    console.log(`  total cost:        $${result.spentUsd.toFixed(4)}`);
    console.log(`  db:                ${dbPath}`);
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

program
  .command("report")
  .description("Generate a markdown findings report for a completed run.")
  .argument("<run-id>", "id of a previously run/analyzed run")
  .requiredOption(
    "-d, --db <path>",
    "path to the run's SQLite file (the --out path from `drover run`)",
  )
  .option("-o, --out <path>", "write the report to this file instead of printing it to stdout")
  .action(async (runId: string, options: { db: string; out?: string }) => {
    try {
      await reportCommand(runId, options);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("stampede")
  .description(
    "Replay a completed discovery run's discovered routes as scripted (non-LLM) load-test traffic.",
  )
  .argument("<run-id>", "id of a previously completed discovery run to pull routes/target from")
  .requiredOption(
    "-d, --db <path>",
    "path to the run's SQLite file (the --out path from `drover run`)",
  )
  .option(
    "--concurrency <levels>",
    "comma-separated concurrency levels to test, in order",
    DEFAULT_CONCURRENCY_LEVELS.join(","),
  )
  .option(
    "--iterations-per-worker <n>",
    "full route-list passes each concurrent worker makes per level",
    String(DEFAULT_ITERATIONS_PER_WORKER),
  )
  .action(
    async (
      runId: string,
      options: { db: string; concurrency: string; iterationsPerWorker: string },
    ) => {
      try {
        await stampedeCommand(runId, options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    },
  );

program
  .command("grade")
  .description(
    "Validate and dispatch a Grading Run for a GraderPack (Grader — a separate subsystem, see CONTEXT.md's Glossary).",
  )
  .argument("<pack>", "path to a .ts module exporting a GraderPack as its default export")
  .option(
    "-d, --db <path>",
    "grader.sqlite output file path — reused across invocations by default (default: ./grader.sqlite); pass a different path for a scratch run or CI-specific output",
  )
  .option(
    "-r, --report <path>",
    "write the Grading report to this file instead of printing it to stdout",
  )
  .option(
    "-j, --json [path]",
    "emit the versioned CI JSON summary (ADR 0005) — to this file if a path is given, to stdout otherwise; omit entirely to skip it",
  )
  .action(
    async (
      packPath: string,
      options: { db?: string; report?: string; json?: string | boolean },
    ) => {
      try {
        await gradeCommand(packPath, options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    },
  );

const soakCommand = program
  .command("soak")
  .description(
    'Soak mode — a long-running continuous-execution mode (CONTEXT.md Glossary: "Soak mode"), a separate subsystem, see CTS.md.',
  );

soakCommand
  .command("run")
  .description(
    "Validate a SoakBlueprint and execute a soak run against it (no local-model text variation yet — CTS.md Soak Session 4).",
  )
  .argument("<blueprint>", "path to a .ts module exporting a SoakBlueprint as its default export")
  .option(
    "-d, --db <path>",
    "soak.sqlite output file path — reused across invocations by default (default: ./soak.sqlite)",
  )
  .action(async (blueprintPath: string, options: { db?: string }) => {
    try {
      await soakRunCommand(blueprintPath, options);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
