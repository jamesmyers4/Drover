/**
 * Layer 6 — consistency/stability (FUTUREPLAN.md's layer catalogue, §1's
 * technique 6). Mechanically a multi-judge Consensus Round dispatch
 * (`consensus-layer.ts`); what distinguishes it from Layers 4/5/7 is purely
 * the prompt framing — judges check whether multiple samples embedded in
 * `Case.output` agree in substance, per `CONSISTENCY_FRAMING`'s doc comment
 * on the Case-schema tension this implies.
 */

import type { GraderBudget } from "../budget.js";
import type { LayerImplementation } from "../layer.js";
import { CONSISTENCY_FRAMING } from "../prompt.js";
import type { GraderModelProvider } from "../provider.js";
import { createMultiJudgeLayer } from "./consensus-layer.js";

export function createLayer6(
  judges: GraderModelProvider[],
  escalationProvider: GraderModelProvider,
  budget?: GraderBudget,
): LayerImplementation {
  return createMultiJudgeLayer(
    6,
    CONSISTENCY_FRAMING,
    judges,
    escalationProvider,
    budget !== undefined ? { budget } : undefined,
  );
}
