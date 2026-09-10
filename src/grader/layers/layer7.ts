/**
 * Layer 7 — adversarial/prompt-injection (FUTUREPLAN.md's layer catalogue,
 * §1's technique 7). Mechanically a multi-judge Consensus Round dispatch
 * (`consensus-layer.ts`); what distinguishes it from Layers 4-6 is purely
 * the prompt framing — judges check the output itself for signs of
 * injected-instruction compliance, per `ADVERSARIAL_FRAMING`.
 */

import type { GraderBudget } from "../budget.js";
import type { LayerImplementation } from "../layer.js";
import { ADVERSARIAL_FRAMING } from "../prompt.js";
import type { GraderModelProvider } from "../provider.js";
import { createMultiJudgeLayer } from "./consensus-layer.js";

export function createLayer7(
  judges: GraderModelProvider[],
  escalationProvider: GraderModelProvider,
  budget?: GraderBudget,
): LayerImplementation {
  return createMultiJudgeLayer(
    7,
    ADVERSARIAL_FRAMING,
    judges,
    escalationProvider,
    budget !== undefined ? { budget } : undefined,
  );
}
