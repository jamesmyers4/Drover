/**
 * Layer 3 — single LLM-judge (FUTUREPLAN.md's layer catalogue, §1's
 * technique 3), decomposed into named Checks per the rubric. Mechanically a
 * single-judge rubric dispatch (`judge-layer.ts`); what distinguishes it
 * from Layer 2 is purely the prompt framing — an open-ended judgment of the
 * output against each rubric criterion on its own merits, not a comparison
 * against known-good golden examples.
 */

import type { LayerImplementation } from "../layer.js";
import { LLM_JUDGE_FRAMING } from "../prompt.js";
import type { GraderModelProvider } from "../provider.js";
import { createSingleJudgeLayer } from "./judge-layer.js";

export function createLayer3(provider: GraderModelProvider): LayerImplementation {
  return createSingleJudgeLayer(3, LLM_JUDGE_FRAMING, provider);
}
