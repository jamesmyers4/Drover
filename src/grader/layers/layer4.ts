/**
 * Layer 4 — pairwise/arena-style LLM-as-judge (FUTUREPLAN.md's layer
 * catalogue, §1's technique 4). Mechanically a multi-judge Consensus Round
 * dispatch (`consensus-layer.ts`); what distinguishes it from Layers 5-7 is
 * purely the prompt framing — judges are asked to compare two candidates
 * embedded in `Case.output`, per `PAIRWISE_COMPARISON_FRAMING`'s doc
 * comment on the Case-schema tension this implies.
 */

import type { GraderBudget } from "../budget.js";
import type { LayerImplementation } from "../layer.js";
import { PAIRWISE_COMPARISON_FRAMING } from "../prompt.js";
import type { GraderModelProvider } from "../provider.js";
import { createMultiJudgeLayer } from "./consensus-layer.js";

export function createLayer4(
  judges: GraderModelProvider[],
  escalationProvider: GraderModelProvider,
  budget?: GraderBudget,
): LayerImplementation {
  return createMultiJudgeLayer(
    4,
    PAIRWISE_COMPARISON_FRAMING,
    judges,
    escalationProvider,
    budget !== undefined ? { budget } : undefined,
  );
}
