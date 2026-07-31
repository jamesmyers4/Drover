/**
 * Layer 2 — golden dataset regression (FUTUREPLAN.md's layer catalogue,
 * §1.2). Mechanically a single-judge rubric dispatch (`judge-layer.ts`);
 * what distinguishes it from Layer 3 is purely the prompt framing — the
 * judge is told to check the output against the rubric's Checks as
 * *expected properties established from prior known-good examples*, not as
 * an open-ended quality judgment.
 */

import type { LayerImplementation } from "../layer.js";
import { GOLDEN_REGRESSION_FRAMING } from "../prompt.js";
import type { GraderModelProvider } from "../provider.js";
import { createSingleJudgeLayer } from "./judge-layer.js";

export function createLayer2(provider: GraderModelProvider): LayerImplementation {
  return createSingleJudgeLayer(2, GOLDEN_REGRESSION_FRAMING, provider);
}
