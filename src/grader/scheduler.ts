/**
 * Grader's dispatch loop (FUTUREPLAN.md Grader Session 3) — reads a Case's
 * accumulated Task results, resolves the declared prerequisite DAG in
 * topological order, and dispatches the next eligible Task. Always-run-
 * everything is the default (Q5): a declared prerequisite only skips a
 * layer when genuinely unmet, and only because it carries the justification
 * string `validateGraderPack` already requires at pack-load time.
 *
 * Dispatch is fully sequential (ADR 0004): one Task in flight system-wide —
 * Cases are processed one at a time, and within a Case, layers are
 * processed one at a time in dispatch order. Every dispatched Task still
 * records `executionTarget`/`modelFamily` when the layer implementation
 * supplies them, even though nothing consumes them for concurrency yet.
 */

import { type GraderDb, newGraderId } from "./db.js";
import type { LayerCheckOutcome, LayerRegistry } from "./layer.js";
import { layer1 } from "./layers/layer1.js";
import { validateGraderPack } from "./pack-validation.js";
import type {
  Case,
  GraderPack,
  GraderPackConfigSnapshot,
  GradingRunStatus,
  LayerId,
  Task,
  TaskStatus,
} from "./types.js";

/** Grows as later sessions add real layer implementations (Session 4: layers 2-3, Session 6: 4-7). */
export const DEFAULT_LAYER_REGISTRY: LayerRegistry = { 1: layer1 };

/**
 * Topological order over every layer id that will actually be dispatched
 * this run — the registry's implemented layers, minus any explicitly
 * disabled via `pack.layers[id].enabled === false`. A `requires` edge
 * pointing at a layer id outside that dispatch set (not implemented yet, or
 * disabled) is dropped from the graph itself — that layer will never
 * produce a passing Task, so any dependent's prerequisite is simply always
 * unmet; nothing about the *order* needs to account for a layer that never
 * runs (`dispatchCaseTasks` below is what actually applies that unmet-ness).
 *
 * Deterministic: ties are broken by ascending layer id, so re-running the
 * same pack against the same registry always dispatches in the same order.
 *
 * Throws if the dispatch-candidate subset itself has a cycle. Shouldn't
 * happen for a pack that already passed `validateGraderPack` (which checks
 * the *full* declared DAG, not just whichever layers happen to be
 * implemented in `registry`), but the subset relationship isn't airtight
 * enough to assume silently — failing loudly beats an infinite loop.
 */
export function resolveLayerDispatchOrder(pack: GraderPack, registry: LayerRegistry): LayerId[] {
  const candidates = new Set<LayerId>(
    Object.keys(registry)
      .map((key) => Number(key) as LayerId)
      .filter((layerId) => pack.layers?.[layerId]?.enabled !== false),
  );

  const dependsOn = new Map<LayerId, LayerId[]>();
  for (const layerId of candidates) {
    const requires = pack.layers?.[layerId]?.requires ?? [];
    dependsOn.set(
      layerId,
      requires.map((req) => req.layerId).filter((dep) => candidates.has(dep)),
    );
  }

  const order: LayerId[] = [];
  const placed = new Set<LayerId>();
  const remaining = new Set(candidates);
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((layerId) => (dependsOn.get(layerId) ?? []).every((dep) => placed.has(dep)))
      .sort((a, b) => a - b);
    if (ready.length === 0) {
      throw new Error(
        `Cannot resolve a dispatch order for layers [${[...remaining].join(", ")}] — the ` +
          "declared prerequisite DAG has a cycle among the layers currently registered for " +
          "dispatch. This pack should have failed validateGraderPack() before reaching the " +
          "scheduler.",
      );
    }
    for (const layerId of ready) {
      order.push(layerId);
      placed.add(layerId);
      remaining.delete(layerId);
    }
  }
  return order;
}

/**
 * Runs every dispatchable layer for one Case, in `order`, writing one Task
 * row per layer. `taskStatusByLayer` accumulates as the loop proceeds so a
 * later layer's prerequisite check sees this Case's own real results —
 * reset fresh per Case, never carried over from a different Case.
 */
async function dispatchCaseTasks(
  db: GraderDb,
  pack: GraderPack,
  registry: LayerRegistry,
  gradingCase: Case,
  order: LayerId[],
  now: () => number,
): Promise<{ passed: number; failed: number; skipped: number }> {
  const taskStatusByLayer = new Map<LayerId, TaskStatus>();
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const layerId of order) {
    const impl = registry[layerId];
    if (!impl) continue;

    // "Genuinely unmet" (Q5) covers a prerequisite layer that never ran
    // (not implemented / disabled), failed, or was itself skipped — the
    // last case is what makes a skip correctly cascade down a chain of
    // dependents rather than stopping at the first hop.
    const requires = pack.layers?.[layerId]?.requires ?? [];
    const unmet = requires.find((req) => taskStatusByLayer.get(req.layerId) !== "pass");

    const startedAt = now();
    if (unmet) {
      const task: Task = {
        id: newGraderId(),
        caseId: gradingCase.id,
        layerId,
        status: "skipped",
        checks: [],
        skippedReason: unmet.justification,
        startedAt,
        endedAt: startedAt,
      };
      db.insertTask(task);
      taskStatusByLayer.set(layerId, "skipped");
      skipped++;
      continue;
    }

    // A layer implementation throwing (a judge unreachable, a malformed
    // response, any real fault) is isolated to this one Task, exactly like
    // a normal fail — never lets one bad Task escalate into a whole-run
    // `crashed` state. This is Q5's coverage-over-cost guarantee applied at
    // Task granularity: one structurally-odd Case shouldn't cost the rest
    // of the batch its results, any more than one failing layer should stop
    // the others from running. A downstream dependent's prerequisite check
    // still sees this as "not pass," so a skip correctly cascades from a
    // caught throw exactly as it would from an ordinary fail.
    let outcome: LayerCheckOutcome;
    try {
      outcome = await impl.run({ gradingCase, pack });
    } catch (err) {
      outcome = {
        status: "fail",
        checks: [
          {
            name: "task-execution-error",
            value: false,
            reasoning: `Layer ${layerId} implementation threw: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
    const endedAt = now();
    const task: Task = {
      id: newGraderId(),
      caseId: gradingCase.id,
      layerId,
      status: outcome.status,
      checks: outcome.checks,
      ...(outcome.modelFamily !== undefined && { modelFamily: outcome.modelFamily }),
      ...(outcome.executionTarget !== undefined && { executionTarget: outcome.executionTarget }),
      ...(outcome.rubricSnapshot !== undefined && { rubricSnapshot: outcome.rubricSnapshot }),
      startedAt,
      endedAt,
    };
    db.insertTask(task);
    taskStatusByLayer.set(layerId, outcome.status);
    if (outcome.status === "pass") passed++;
    else failed++;
  }

  return { passed, failed, skipped };
}

function buildPackConfigSnapshot(pack: GraderPack): GraderPackConfigSnapshot {
  return {
    appName: pack.appName,
    rubrics: pack.rubrics,
    ...(pack.layers !== undefined && { layers: pack.layers }),
    dataPolicy: pack.dataPolicy,
    ...(pack.allowHostedEscalation !== undefined && {
      allowHostedEscalation: pack.allowHostedEscalation,
    }),
    ...(pack.graderCeilingUsd !== undefined && { graderCeilingUsd: pack.graderCeilingUsd }),
  };
}

export interface RunGradingRunOptions {
  db: GraderDb;
  pack: GraderPack;
  /** @default DEFAULT_LAYER_REGISTRY */
  layers?: LayerRegistry;
  /** Injectable clock for deterministic tests. @default Date.now */
  now?: () => number;
}

export interface RunGradingRunResult {
  gradingRunId: string;
  status: GradingRunStatus;
  casesProcessed: number;
  tasksPassed: number;
  tasksFailed: number;
  tasksSkipped: number;
}

/**
 * Runs one full Grading Run end to end: validates the pack (never inserts a
 * `grading_runs` row for a pack that fails validation — closes the
 * breadcrumb left in `src/cli/index.ts`'s `gradeCommand` doc comment), then
 * dispatches every eligible layer's Task for every Case, fully sequentially
 * (ADR 0004). Reuses `validateGraderPack`'s returned Case list rather than
 * calling `pack.loadCases()` again — see that function's doc comment for
 * why a second call would be a real correctness risk, not just redundant
 * work.
 *
 * A single Task throwing (a layer implementation error — none of Layer 1's
 * checks can throw, but a later LLM-backed layer plausibly can) is caught
 * and recorded as that Task's own `fail`, never escalated to a whole-run
 * failure (Q5's coverage-over-cost guarantee, applied at Task granularity —
 * see `dispatchCaseTasks`). The `grading_runs` row only ends up `crashed`
 * for a genuine orchestration-level fault: a DB write itself throwing, or
 * (in principle — can't happen for an already-validated pack, see
 * `resolveLayerDispatchOrder`'s doc comment) a cycle in the dispatch order.
 * Left in a terminal `crashed` state rather than stuck at `running`
 * forever, mirroring `runDiscovery`'s finally-style status update for the
 * simulation stack.
 */
export async function runGradingRun(opts: RunGradingRunOptions): Promise<RunGradingRunResult> {
  const { db, pack } = opts;
  const registry = opts.layers ?? DEFAULT_LAYER_REGISTRY;
  const now = opts.now ?? Date.now;

  const cases = await validateGraderPack(pack);

  const gradingRunId = newGraderId();
  db.insertGradingRun({
    id: gradingRunId,
    appName: pack.appName,
    packConfig: buildPackConfigSnapshot(pack),
    status: "running",
    startedAt: now(),
  });

  try {
    const order = resolveLayerDispatchOrder(pack, registry);

    let casesProcessed = 0;
    let tasksPassed = 0;
    let tasksFailed = 0;
    let tasksSkipped = 0;

    for (const input of cases) {
      const gradingCase: Case = {
        id: newGraderId(),
        gradingRunId,
        input: input.input,
        output: input.output,
        rubric: input.rubric,
        createdAt: now(),
      };
      db.insertCase(gradingCase);
      casesProcessed++;

      const result = await dispatchCaseTasks(db, pack, registry, gradingCase, order, now);
      tasksPassed += result.passed;
      tasksFailed += result.failed;
      tasksSkipped += result.skipped;
    }

    const endedAt = now();
    db.updateGradingRunStatus(gradingRunId, "completed", endedAt);

    return {
      gradingRunId,
      status: "completed",
      casesProcessed,
      tasksPassed,
      tasksFailed,
      tasksSkipped,
    };
  } catch (err) {
    db.updateGradingRunStatus(gradingRunId, "crashed", now());
    throw err;
  }
}
