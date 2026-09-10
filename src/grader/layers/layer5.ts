/**
 * Layer 5 — faithfulness/groundedness (FUTUREPLAN.md's layer catalogue,
 * §1's technique 5). Mechanically a multi-judge Consensus Round dispatch
 * (`consensus-layer.ts`); what distinguishes it from Layers 4/6/7 is purely
 * the prompt framing — judges check every claim in the output traces back
 * to the input, per `FAITHFULNESS_FRAMING`.
 */

import type { GraderBudget } from "../budget.js";
import type { LayerImplementation } from "../layer.js";
import { FAITHFULNESS_FRAMING } from "../prompt.js";
import type { GraderModelProvider } from "../provider.js";
import { createMultiJudgeLayer } from "./consensus-layer.js";

export function createLayer5(
  judges: GraderModelProvider[],
  escalationProvider: GraderModelProvider,
  budget?: GraderBudget,
): LayerImplementation {
  return createMultiJudgeLayer(
    5,
    FAITHFULNESS_FRAMING,
    judges,
    escalationProvider,
    budget !== undefined ? { budget } : undefined,
  );
}
