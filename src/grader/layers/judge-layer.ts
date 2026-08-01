/**
 * Shared dispatch shape for a single-judge, rubric-consuming layer
 * (FUTUREPLAN.md Grader Session 4: "local single-judge layers (2-3)").
 * Layer 2 (golden dataset regression) and Layer 3 (single LLM-judge) are
 * mechanically identical — resolve the Case's rubric, ask a
 * `GraderModelProvider` to score every Check in one call, snapshot the
 * rubric onto the result (Q8). What differs between them is purely the
 * prompt framing (`prompt.ts`'s `GOLDEN_REGRESSION_FRAMING` vs.
 * `LLM_JUDGE_FRAMING`) — no different code path, so this lives in its own
 * module rather than being duplicated in `layer2.ts`/`layer3.ts`.
 */

import type { LayerCheckOutcome, LayerImplementation, LayerRunContext } from "../layer.js";
import type { GraderModelProvider } from "../provider.js";
import { resolveRubric, snapshotRubric } from "../rubric.js";
import type { CheckDefinition, LayerId } from "../types.js";

/**
 * A single Check's own pass/fail verdict, independent of any other judge or
 * Consensus Round. Boolean: the value itself is the verdict. Numeric: the
 * resolved score is compared against the Check's own `passThreshold`
 * (`comparison`/`value`), never `numericTolerance` — that field governs
 * judge-to-judge *agreement* only (Q11), not the quality bar for a single
 * judge's own score. `validateGraderPack` already guarantees every numeric
 * Check carries a well-formed `passThreshold`, so this doesn't re-validate
 * shape, only applies it.
 *
 * Exported so `consensus.ts` can reuse the exact same single-judge verdict
 * rule for a judge Task's own status and for computing an escalation Task's
 * verdict on its one scoped Check — there's exactly one definition of "does
 * this Check's value pass," and it shouldn't drift into two copies.
 */
export function checkPasses(def: CheckDefinition, value: boolean | number): boolean {
  if (def.scoringType === "boolean") return value === true;
  const { comparison, value: threshold } = def.passThreshold;
  return comparison === "gte" ? (value as number) >= threshold : (value as number) <= threshold;
}

export function createSingleJudgeLayer(
  layerId: LayerId,
  framing: string,
  provider: GraderModelProvider,
): LayerImplementation {
  return {
    layerId,
    async run(ctx: LayerRunContext): Promise<LayerCheckOutcome> {
      const rubric = resolveRubric(ctx.pack, ctx.gradingCase.rubric);
      const result = await provider.score({
        input: ctx.gradingCase.input,
        output: ctx.gradingCase.output,
        rubric,
        framing,
      });

      // A single-judge Task's overall status is "pass" only if every Check
      // individually passes its own verdict rule — boolean Checks via their
      // true/false value, numeric Checks via `passThreshold`. Corrected
      // after Session 4's first pass, which left numeric Checks unable to
      // fail a Task at all (see GAPS.md's now-resolved 2026-07-31 entry):
      // two judges agreeing perfectly on a "3/10" faithfulness score would
      // have reported a clean pass, since nothing converted that score into
      // a verdict before Session 5's consensus logic ever compared it.
      const defByName = new Map(rubric.checks.map((def) => [def.name, def]));
      const status = result.checks.every((check) => {
        const def = defByName.get(check.name);
        return def ? checkPasses(def, check.value) : true;
      })
        ? "pass"
        : "fail";

      return {
        status,
        checks: result.checks,
        modelFamily: provider.modelFamily,
        executionTarget: provider.executionTarget,
        rubricSnapshot: snapshotRubric(rubric),
      };
    },
  };
}
