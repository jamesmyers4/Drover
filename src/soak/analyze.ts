/**
 * `drover soak analyze`'s entry point (CTS.md Soak Session 7) — ties
 * Session 6's cross-turn pass and Session 5's Grader-Case adapter together
 * behind one function, persisting both sets of findings. The Grader pass is
 * opt-in: it only runs when the given blueprint declares
 * `graderIntegration` (see that field's doc comment, `types.ts`) — ADR 0010
 * keeps target-specific rubric content out of Drover's own repo, so a
 * generic `drover soak analyze` invocation has no rubrics of its own to
 * fall back to when a blueprint doesn't supply any.
 */

import type { GraderDb } from "../grader/db.js";
import type { GraderModelRouting } from "../grader/grade.js";
import { runGrading } from "../grader/grade.js";
import { defaultGraderRouting } from "../grader/routing.js";
import type { GraderPack } from "../grader/types.js";
import { runCrossTurnAnalysis } from "./cross-turn.js";
import type { CrossTurnProvider } from "./cross-turn-provider.js";
import type { SoakDb } from "./db.js";
import { newSoakId } from "./db.js";
import { turnToCase } from "./grader-adapter.js";
import type { SoakBlueprint } from "./types.js";

export class SoakRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`No soak run found with id "${runId}".`);
    this.name = "SoakRunNotFoundError";
  }
}

export interface RunSoakAnalysisOptions {
  db: SoakDb;
  runId: string;
  /**
   * The blueprint this run executed against — needed only for the Grader
   * pass (`graderIntegration`'s rubrics/`rubricKeyFor` are functions, not
   * serializable, so they're never read back from `soak_runs`' own stored
   * snapshot; this must be the live blueprint, reloaded fresh the same way
   * `drover soak run` loads it). Omit to run the cross-turn pass only.
   */
  blueprint?: SoakBlueprint;
  /** Required when `blueprint.graderIntegration` is set — the caller (the CLI) owns this database's lifecycle. */
  graderDb?: GraderDb;
  /** @default defaultGraderRouting(graderPack) */
  routing?: GraderModelRouting;
  /** Injectable for tests — defaults to a real `BatchCrossTurnProvider`. */
  crossTurnProvider?: CrossTurnProvider;
  /** @default DEFAULT_TURNS_PER_CHUNK */
  turnsPerChunk?: number;
  /** Injectable clock for deterministic tests. @default Date.now */
  now?: () => number;
}

export interface RunSoakAnalysisGraderResult {
  gradingRunId: string;
  casesProcessed: number;
  tasksPassed: number;
  tasksFailed: number;
  tasksSkipped: number;
}

export interface RunSoakAnalysisResult {
  runId: string;
  turnsAnalyzed: number;
  crossTurnFindingsWritten: number;
  crossTurnFindingsSkipped: number;
  crossTurnCostUsd: number;
  /** Present only when the Grader pass actually ran. */
  grader?: RunSoakAnalysisGraderResult;
  /** Present only when the Grader pass was skipped — explains why, rather than silently omitting a whole category of findings without saying so (CTS.md's own explicit instruction). */
  graderSkippedReason?: string;
}

/**
 * Runs both analysis passes over one soak run's turns and persists their
 * findings. The cross-turn pass always runs (it needs nothing but this
 * run's own turns); the Grader pass runs only when `opts.blueprint.
 * graderIntegration` is configured, building a `GraderPack` on the fly from
 * it — `loadCases` maps every turn with a real response through `turnToCase`
 * with the blueprint-supplied `rubricKeyFor`/`contextFor` (a turn with no
 * `responsePayload` — e.g. a variation failure that never reached HTTP
 * dispatch — is excluded first: it has nothing to grade, and Grader's own
 * `Case.output` is NOT NULL), `dataPolicy` is reused directly from the
 * blueprint (restricted soak content should stay behind local judges for
 * grading too, not just for driving), and judge routing defaults via
 * `defaultGraderRouting` unless the caller overrides it.
 */
export async function runSoakAnalysis(
  opts: RunSoakAnalysisOptions,
): Promise<RunSoakAnalysisResult> {
  const { db, runId } = opts;
  const run = db.getSoakRun(runId);
  if (!run) throw new SoakRunNotFoundError(runId);

  const now = opts.now ?? Date.now;
  const turns = db.getTurnsByRun(runId);

  const crossTurnResult = await runCrossTurnAnalysis({
    turns,
    ...(opts.crossTurnProvider !== undefined && { provider: opts.crossTurnProvider }),
    ...(opts.turnsPerChunk !== undefined && { turnsPerChunk: opts.turnsPerChunk }),
  });

  const createdAt = now();
  for (const finding of crossTurnResult.findings) {
    db.insertCrossTurnFinding({ id: newSoakId(), runId, createdAt, ...finding });
  }
  db.updateSoakRunCrossTurnCost(runId, crossTurnResult.costUsd);

  let grader: RunSoakAnalysisGraderResult | undefined;
  let graderSkippedReason: string | undefined;

  if (opts.blueprint === undefined) {
    graderSkippedReason =
      "no blueprint supplied — pass one to enable Grader-sourced findings (CTS.md Soak Session 5)";
  } else if (opts.blueprint.graderIntegration === undefined) {
    graderSkippedReason = `blueprint "${opts.blueprint.appName}" has no graderIntegration configured — Grader-sourced findings skipped`;
  } else {
    if (!opts.graderDb) {
      throw new Error(
        "runSoakAnalysis: blueprint.graderIntegration is configured but no graderDb was supplied.",
      );
    }
    const integration = opts.blueprint.graderIntegration;
    const graderPack: GraderPack = {
      appName: opts.blueprint.appName,
      rubrics: integration.rubrics,
      // A turn with no responsePayload (e.g. a variation failure that never
      // reached HTTP dispatch — scheduler.ts's dispatchTurn) has nothing to
      // grade: Grader's own Case.output is NOT NULL, and there's no content
      // for a rubric to judge in the first place. Found for real running
      // Soak Session 8's own reference validation (a Case with `output:
      // undefined` throws a real SQLITE_CONSTRAINT_NOTNULL, not a
      // hypothetical) — excluded here rather than crashing the whole
      // Grader pass over turns that were never going to be gradeable.
      loadCases: () =>
        turns
          .filter((turn) => turn.responsePayload !== undefined)
          .map((turn) =>
            turnToCase(turn, integration.rubricKeyFor, integration.contextFor?.(turn)),
          ),
      dataPolicy: opts.blueprint.dataPolicy,
      ...(integration.layers !== undefined && { layers: integration.layers }),
      ...(integration.allowHostedEscalation !== undefined && {
        allowHostedEscalation: integration.allowHostedEscalation,
      }),
      ...(integration.graderCeilingUsd !== undefined && {
        graderCeilingUsd: integration.graderCeilingUsd,
      }),
    };
    const routing = opts.routing ?? defaultGraderRouting(graderPack);
    const gradingResult = await runGrading({ db: opts.graderDb, pack: graderPack, routing });
    db.updateSoakRunGradingRunId(runId, gradingResult.gradingRunId);
    grader = {
      gradingRunId: gradingResult.gradingRunId,
      casesProcessed: gradingResult.casesProcessed,
      tasksPassed: gradingResult.tasksPassed,
      tasksFailed: gradingResult.tasksFailed,
      tasksSkipped: gradingResult.tasksSkipped,
    };
  }

  return {
    runId,
    turnsAnalyzed: crossTurnResult.turnsAnalyzed,
    crossTurnFindingsWritten: crossTurnResult.findings.length,
    crossTurnFindingsSkipped: crossTurnResult.findingsSkipped,
    crossTurnCostUsd: crossTurnResult.costUsd,
    ...(grader !== undefined && { grader }),
    ...(graderSkippedReason !== undefined && { graderSkippedReason }),
  };
}
