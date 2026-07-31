/**
 * The contract a layer implementation must satisfy to be dispatched by
 * `scheduler.ts` — analogous to the actor tier's `ModelProvider` interface
 * (`src/actor/provider.ts`): an execution-tier seam, not a config schema, so
 * it lives in its own file rather than `types.ts`. Kept separate from
 * `scheduler.ts` itself so a layer module (e.g. `layers/layer1.ts`) and the
 * scheduler can each import these types without a circular module
 * dependency between the two.
 */

import type { Case, CheckResult, GraderPack, LayerId, RubricSnapshot } from "./types.js";

export interface LayerRunContext {
  gradingCase: Case;
  pack: GraderPack;
}

export interface LayerCheckOutcome {
  status: "pass" | "fail";
  /** One layer/one Task can score several Checks in a single pass. */
  checks: CheckResult[];
  /** LLM-backed layers only (ADR 0003) — a deterministic layer like Layer 1 leaves this unset. */
  modelFamily?: string;
  /** LLM-backed layers only (ADR 0004) — a deterministic layer like Layer 1 leaves this unset. */
  executionTarget?: string;
  /** Layers that consume a named rubric only — Layer 1's deterministic checks don't (Case glossary entry). */
  rubricSnapshot?: RubricSnapshot;
}

/** Not every layer is an LLM call — a deterministic layer like Layer 1 is plain synchronous code, hence the non-Promise return option. */
export interface LayerImplementation {
  layerId: LayerId;
  run: (ctx: LayerRunContext) => Promise<LayerCheckOutcome> | LayerCheckOutcome;
}

/** Sparse — only layer ids with a real implementation registered are dispatchable this run. */
export type LayerRegistry = Partial<Record<LayerId, LayerImplementation>>;
