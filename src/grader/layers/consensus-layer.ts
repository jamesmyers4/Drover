/**
 * Shared dispatch shape for a multi-judge, Consensus-Round-backed layer
 * (FUTUREPLAN.md Grader Session 6: "Layers 4-7"). Mirrors `judge-layer.ts`'s
 * role for the single-judge layers (2-3) — Layers 4-7 are mechanically
 * identical to each other (resolve the Case's rubric, run a full Consensus
 * Round via `consensus.ts`, fold the round's per-Check resolution into one
 * summary Task the scheduler can persist and use for prerequisite checks).
 * What differs between them is purely the prompt framing (`prompt.ts`'s
 * `PAIRWISE_COMPARISON_FRAMING`/`FAITHFULNESS_FRAMING`/`CONSISTENCY_FRAMING`/
 * `ADVERSARIAL_FRAMING`) — no different code path, so this lives in its own
 * module rather than being duplicated across `layer4.ts`-`layer7.ts`.
 *
 * This is the piece Session 5 explicitly deferred: `runConsensusRound`
 * itself already persists every judge/escalation Task it dispatches
 * directly via `db` (consensus.ts's own "write as you go" precedent), so
 * this layer's `run()` does *not* return those as its `LayerCheckOutcome` —
 * `dispatchCaseTasks` would otherwise double-record them. Instead it
 * returns one additional *summary* Task representing the layer's overall
 * verdict for this Case — the thing `dispatchCaseTasks`'s prerequisite/
 * pass-fail bookkeeping actually operates on, exactly as a single-judge
 * layer's one Task does. The judge/escalation Tasks and the round's own row
 * remain queryable independently (by `consensusRoundId`) for anyone wanting
 * the full audit trail — this summary Task is a rollup, not a replacement.
 */

import type { GraderBudget } from "../budget.js";
import { runConsensusRound } from "../consensus.js";
import type { LayerCheckOutcome, LayerImplementation, LayerRunContext } from "../layer.js";
import type { GraderModelProvider } from "../provider.js";
import { resolveRubric, snapshotRubric } from "../rubric.js";
import type { CheckDefinition, CheckResult, LayerId } from "../types.js";
import { checkPasses } from "./judge-layer.js";

/** Truncate-don't-reject, same discipline `MAX_REASONING_LENGTH` enforces elsewhere — an abort reason is an arbitrary caught error message, not a bounded model output, so it needs its own cap. */
const MAX_ABORT_REASON_LENGTH = 200;

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function summarizeResolutionReasoning(outcome: "agreed" | "escalated"): string {
  return outcome === "agreed"
    ? "Judges agreed on this Check; no escalation was needed."
    : "Judges disagreed on this Check; a scoped escalation Task adjudicated the final value.";
}

export interface MultiJudgeLayerOptions {
  budget?: GraderBudget;
  /** Forwarded to `runConsensusRound` — test-only override so a forced-failure test doesn't wait out real retry backoff. @default runConsensusRound's own default (3) */
  maxDispatchAttempts?: number;
  /** Forwarded to `runConsensusRound` — test-only override. @default runConsensusRound's own default (a real setTimeout-based sleep) */
  sleep?: (ms: number) => Promise<void>;
}

export function createMultiJudgeLayer(
  layerId: LayerId,
  framing: string,
  judges: GraderModelProvider[],
  escalationProvider: GraderModelProvider,
  options?: MultiJudgeLayerOptions,
): LayerImplementation {
  return {
    layerId,
    async run(ctx: LayerRunContext): Promise<LayerCheckOutcome> {
      const rubric = resolveRubric(ctx.pack, ctx.gradingCase.rubric);
      const rubricSnapshot = snapshotRubric(rubric);

      const result = await runConsensusRound({
        db: ctx.db,
        pack: ctx.pack,
        gradingCase: ctx.gradingCase,
        layerId,
        framing,
        judges,
        escalationProvider,
        ...(options?.budget !== undefined && { budget: options.budget }),
        ...(options?.maxDispatchAttempts !== undefined && {
          maxDispatchAttempts: options.maxDispatchAttempts,
        }),
        ...(options?.sleep !== undefined && { sleep: options.sleep }),
        now: ctx.now,
      });

      // A round that exhausted every retry (infrastructure noise, not a
      // quality signal — see consensus.ts's own header comment) is reported
      // as this layer's Task failing, never as a whole-run crash: same
      // Task-level error-isolation precedent `dispatchCaseTasks` already
      // applies to a layer implementation throwing outright.
      if (result.status === "aborted-error") {
        const checks: CheckResult[] = [
          {
            name: "consensus-round-error",
            value: false,
            reasoning: truncate(
              `Consensus Round aborted after exhausting retries: ${result.abortedReason ?? "unknown error"}`,
              MAX_ABORT_REASON_LENGTH,
            ),
          },
        ];
        return { status: "fail", checks, rubricSnapshot };
      }

      const defByName = new Map<string, CheckDefinition>(
        rubric.checks.map((def) => [def.name, def]),
      );
      const checks: CheckResult[] = result.checkResolutions.map((resolution) => ({
        name: resolution.name,
        value: resolution.finalValue,
        reasoning: summarizeResolutionReasoning(resolution.outcome),
      }));
      const status = checks.every((check) => {
        const def = defByName.get(check.name);
        return def ? checkPasses(def, check.value) : true;
      })
        ? "pass"
        : "fail";

      return { status, checks, rubricSnapshot };
    },
  };
}
