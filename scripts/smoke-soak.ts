/**
 * Soak Session 8 reference validation script (CTS.md) — runs the full
 * engine end to end (execution -> cross-turn analysis -> Grader analysis ->
 * report) for real against `examples/soak-toy-fixture`, mirroring
 * `examples/toy-app`'s role for the simulation stack and
 * `examples/grader-toy-pack`'s role for Grader. This is the artifact that
 * makes it credible to say "the engine works" before Shenny's own session
 * builds a real blueprint against it (ADR 0010).
 *
 * No local Ollama install is available in this build environment (same gap
 * GAPS.md already tracks for the actor tier/Grader) — the execution phase
 * substitutes a `ScriptedSoakContentProvider` for the variation step and
 * says so explicitly below, rather than faking a real driver-model run.
 * `examples/soak-toy-fixture/blueprint.ts` itself is a fully valid
 * real-Ollama reference regardless of what this particular environment has
 * installed.
 *
 * The cross-turn pass needs a real ANTHROPIC_API_KEY to run for real —
 * skips to a scripted (empty) provider with an explanatory message
 * otherwise, same pattern `smoke-analyst.ts` already established, except
 * the deterministic timing-anomaly half of the pass always still runs for
 * real either way. The Grader pass is Layer-1-only by the blueprint's own
 * `graderIntegration` config (deterministic, no judge model needed), so it
 * always runs regardless of Ollama/Anthropic availability.
 *
 *   npm run smoke:soak
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import blueprint from "../examples/soak-toy-fixture/blueprint.js";
import { startSoakToyFixtureServer } from "../examples/soak-toy-fixture/site-server.js";
import { GraderDb } from "../src/grader/db.js";
import { runSoakAnalysis } from "../src/soak/analyze.js";
import { ScriptedSoakContentProvider } from "../src/soak/content-provider.js";
import { ScriptedCrossTurnProvider } from "../src/soak/cross-turn-provider.js";
import { SoakDb } from "../src/soak/db.js";
import { buildSoakReport } from "../src/soak/report.js";
import { renderSoakReportMarkdown } from "../src/soak/report-markdown.js";
import { runSoak } from "../src/soak/scheduler.js";

/**
 * A generous, repeating bank of pre-written "variations" standing in for
 * what a real local driver model would produce (ADR 0009: the driver only
 * lightly varies pre-authored text — these already look like plausible
 * variations of the blueprint's own example bank, not new content this
 * script is inventing on the model's behalf). Both scheduler lanes draw
 * from this *same* provider instance concurrently, so the effective call
 * count is backbone + messageAnalysis combined, not either alone — repeated
 * generously (well beyond this run's realistic combined turn count) so a
 * longer-than-expected run never hits `ScriptedSoakContentProvider`'s own
 * exhaustion error (which would otherwise show up as spurious "variation
 * failed" explicit-error turns, not a real fixture-app failure).
 */
const VARIATION_BANK = [
  "Had a pretty calm day, nothing much to report.",
  "It was a quiet day overall, nothing notable happened.",
  "Felt somewhat anxious this morning but calmed down by lunchtime.",
  "Was a bit on edge earlier today but settled by midday.",
  "Great day overall — accomplished a lot and felt quite productive.",
  "Really productive day — got a lot done and felt good about it.",
  "Please look at the tone of this message for a follow-up.",
  "Kindly analyze this message's tone for a follow-up action.",
  "Flag anything concerning in this exchange.",
  "Please flag any concerning content in this conversation.",
];
const SCRIPTED_VARIATIONS = Array.from(
  { length: 200 },
  (_, i) => VARIATION_BANK[i % VARIATION_BANK.length] as string,
);

async function main(): Promise<void> {
  mkdirSync("runs", { recursive: true });

  const fixture = await startSoakToyFixtureServer();
  console.log(`Soak toy fixture app listening at ${fixture.baseUrl}`);
  const runtimeBlueprint = { ...blueprint, targetBaseUrl: fixture.baseUrl };

  const soakDbPath = path.join("runs", "smoke-soak.sqlite");
  const soakDb = new SoakDb(soakDbPath);
  const graderDbPath = path.join("runs", "smoke-soak-grader.sqlite");
  const graderDb = new GraderDb(graderDbPath);

  try {
    console.log("\n=== Execution (Soak Sessions 1-4) ===");
    console.log(
      "No local Ollama install available in this build environment — using " +
        "ScriptedSoakContentProvider for the variation step (flagged, not faked). " +
        "The blueprint's own driverProvider/driverModel are a valid real-Ollama " +
        "reference regardless.",
    );

    const execResult = await runSoak({
      db: soakDb,
      blueprint: runtimeBlueprint,
      contentProvider: new ScriptedSoakContentProvider(SCRIPTED_VARIATIONS),
    });

    console.log(`\nSoak run ${execResult.runId}: ${execResult.status}`);
    console.log(`  turns dispatched: ${execResult.turnsDispatched}`);
    console.log(`  explicit errors:  ${execResult.explicitErrorCount}`);
    console.log(`  gated responses:  ${execResult.gatedResponseCount}`);
    console.log(`  total cost:       $${execResult.spentUsd.toFixed(4)}`);

    console.log("\n=== Analysis (Soak Sessions 5-6-7) ===");
    const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
    if (!hasAnthropicKey) {
      console.log(
        "No ANTHROPIC_API_KEY set — the LLM-derived half of the cross-turn pass " +
          "(disagreement/drift/recurring-error-cluster) is scripted (empty) for this " +
          "run; the deterministic timing-anomaly half still runs for real either way.",
      );
    } else {
      console.log("ANTHROPIC_API_KEY present — running the real cross-turn Batch API pass.");
    }
    console.log(
      "Grader pass: Layer 1 only, per the blueprint's own graderIntegration.layers " +
        "config (no local Ollama install available for Layers 2-7 in this environment).",
    );

    const analysisResult = await runSoakAnalysis({
      db: soakDb,
      runId: execResult.runId,
      blueprint: runtimeBlueprint,
      graderDb,
      ...(!hasAnthropicKey && { crossTurnProvider: new ScriptedCrossTurnProvider([]) }),
    });

    console.log(`\nTurns analyzed:           ${analysisResult.turnsAnalyzed}`);
    console.log(
      `Cross-turn findings:      ${analysisResult.crossTurnFindingsWritten} written, ` +
        `${analysisResult.crossTurnFindingsSkipped} skipped`,
    );
    console.log(`Cross-turn analysis cost: $${analysisResult.crossTurnCostUsd.toFixed(4)}`);
    if (analysisResult.grader) {
      console.log(`Grader pass: grading run ${analysisResult.grader.gradingRunId}`);
      console.log(`  cases processed: ${analysisResult.grader.casesProcessed}`);
      console.log(`  tasks passed:    ${analysisResult.grader.tasksPassed}`);
      console.log(`  tasks failed:    ${analysisResult.grader.tasksFailed}`);
    } else {
      console.log(`Grader pass skipped: ${analysisResult.graderSkippedReason}`);
    }

    console.log("\n=== Report (Soak Session 7) ===");
    const report = buildSoakReport(soakDb, execResult.runId, graderDb);
    const markdown = renderSoakReportMarkdown(report);
    const reportPath = path.join("runs", "smoke-soak-report.md");
    writeFileSync(reportPath, markdown);
    console.log(`Report written to ${reportPath}\n`);
    console.log(markdown);
  } finally {
    graderDb.close();
    soakDb.close();
    await fixture.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
