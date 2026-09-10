/**
 * `runGrading` — the entry point tying the scheduler and all seven layers
 * into one coherent Grading Run (FUTUREPLAN.md Grader Session 6). Sessions
 * 4 and 5 both proved their respective layers' dispatch mechanics via an
 * explicit `LayerRegistry` passed directly to `runGradingRun`, deliberately
 * deferring "a default end-to-end CLI pipeline" to this session — this file
 * is that piece.
 *
 * Model routing (`GraderModelRouting`) is a parameter here, not a
 * `GraderPack` field — Session 4 was explicit that "which Ollama model/box"
 * is a run-level concern, not pack content, the same way `ModelRoute` lives
 * on the simulation stack's `SimConfig`, never on `DomainPack`.
 */

import type { ModelRoute } from "../types/index.js";
import type { GraderBudget } from "./budget.js";
import type { GraderDb } from "./db.js";
import type { LayerRegistry } from "./layer.js";
import { layer1 } from "./layers/layer1.js";
import { createLayer2 } from "./layers/layer2.js";
import { createLayer3 } from "./layers/layer3.js";
import { createLayer4 } from "./layers/layer4.js";
import { createLayer5 } from "./layers/layer5.js";
import { createLayer6 } from "./layers/layer6.js";
import { createLayer7 } from "./layers/layer7.js";
import { createGraderModelProvider } from "./provider.js";
import { type RunGradingRunResult, runGradingRun } from "./scheduler.js";
import type { GraderPack, LayerId } from "./types.js";

export interface GraderModelRouting {
  /** Provider for Layers 2-3's single-judge dispatch. */
  singleJudge: ModelRoute;
  /**
   * Judges for Layers 4-7's Consensus Round — needs at least 2 entries,
   * each resolving to a distinct `modelFamily` (ADR 0003). Fewer than 2, or
   * no `escalation` route, means Layers 4-7 are skipped for this run rather
   * than dispatched into a guaranteed `InsufficientJudgesError` — see
   * `buildLayerRegistry`'s doc comment.
   */
  consensusJudges: ModelRoute[];
  /** Escalation provider for Layers 4-7's Consensus Round disagreement path. Only consulted if `consensusJudges` has >= 2 entries. */
  escalation?: ModelRoute;
}

export interface RunGradingOptions {
  db: GraderDb;
  pack: GraderPack;
  routing: GraderModelRouting;
  /**
   * Shared across every Layer 4-7 dispatch this run — constructed once by
   * the caller (not per layer) so escalation spend accumulates correctly
   * across every layer/Case in the run, matching Session 5's own
   * per-Grading-Run budget scope (`GraderPack.graderCeilingUsd`).
   */
  budget?: GraderBudget;
  /** Injectable clock for deterministic tests. @default Date.now (via runGradingRun) */
  now?: () => number;
}

export interface RunGradingResult extends RunGradingRunResult {
  /**
   * Layer ids 4-7 that were actually registered this run — always either
   * `[]` or `[4, 5, 6, 7]` (all four dispatch off the same judge/escalation
   * set). Informational: insufficient distinct judges silently skips them
   * (a console warning, not an error) rather than crashing the run.
   */
  consensusLayersEnabled: LayerId[];
}

/**
 * Builds a full Layers 1-7 registry from real `GraderModelProvider`
 * instances per `routing` — or as many of them as `routing.consensusJudges`
 * actually supports. Layers 4-7 (multi-judge Consensus Round) need >= 2
 * distinct-model-family judges plus an escalation route (ADR 0003); if
 * `routing` doesn't provide that, Layers 4-7 are left out of the registry
 * entirely rather than dispatched into a guaranteed
 * `InsufficientJudgesError`/`DuplicateModelFamilyError` throw.
 * `LayerRegistry` is already sparse by design — a layer id with no
 * implementation registered is simply never dispatched (Session 3's own
 * "not implemented" vs. "disabled" precedent, both treated identically by
 * `resolveLayerDispatchOrder`/`dispatchCaseTasks`) — so this degrades a
 * pack down to whatever real judge diversity this environment actually has
 * right now (e.g. exactly one local model installed) rather than forcing a
 * broken run, with a clear console warning so the gap isn't silent.
 */
export function buildLayerRegistry(
  pack: GraderPack,
  routing: GraderModelRouting,
  budget?: GraderBudget,
): { registry: LayerRegistry; consensusLayersEnabled: LayerId[] } {
  const registry: LayerRegistry = {
    1: layer1,
    2: createLayer2(createGraderModelProvider(routing.singleJudge, pack)),
    3: createLayer3(createGraderModelProvider(routing.singleJudge, pack)),
  };

  const consensusLayersEnabled: LayerId[] = [];
  if (routing.consensusJudges.length >= 2 && routing.escalation !== undefined) {
    const judges = routing.consensusJudges.map((route) => createGraderModelProvider(route, pack));
    const escalationProvider = createGraderModelProvider(routing.escalation, pack);
    registry[4] = createLayer4(judges, escalationProvider, budget);
    registry[5] = createLayer5(judges, escalationProvider, budget);
    registry[6] = createLayer6(judges, escalationProvider, budget);
    registry[7] = createLayer7(judges, escalationProvider, budget);
    consensusLayersEnabled.push(4, 5, 6, 7);
  } else {
    console.warn(
      "[grader] Layers 4-7 (multi-judge Consensus Round) need at least 2 distinct-model-family " +
        `judges plus an escalation route — only ${routing.consensusJudges.length} judge route(s) ` +
        `and ${routing.escalation === undefined ? "no" : "an"} escalation route configured. ` +
        "Skipping Layers 4-7 for this Grading Run.",
    );
  }

  return { registry, consensusLayersEnabled };
}

export async function runGrading(opts: RunGradingOptions): Promise<RunGradingResult> {
  const { registry, consensusLayersEnabled } = buildLayerRegistry(
    opts.pack,
    opts.routing,
    opts.budget,
  );
  const result = await runGradingRun({
    db: opts.db,
    pack: opts.pack,
    layers: registry,
    ...(opts.now !== undefined && { now: opts.now }),
  });
  return { ...result, consensusLayersEnabled };
}
