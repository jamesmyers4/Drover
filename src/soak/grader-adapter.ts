/**
 * Turn → `Case` adapter (CTS.md Soak Session 5; ADR 0008/0010) — the
 * generic, target-agnostic seam that lets any target's soak turns be fed
 * into Grader for single-turn content judging (guardrail leaks,
 * groundedness) without Drover needing to know that target's actual rubric
 * content. A pure data-shape function, not a judging pass — no LLM calls,
 * no dependency on a live Grading Run.
 *
 * Produces a `CaseInput` (`src/grader/types.ts`), the `{input, output,
 * rubric}` triple `GraderPack.loadCases()` returns — not a persisted `Case`
 * (which additionally carries `id`/`gradingRunId`/`createdAt`, assigned by
 * Grader's own scheduler once a real Grading Run exists). A soak turn has
 * no Grading Run at adapter-construction time, so `CaseInput` is the only
 * shape that's actually available to produce here; the target's own
 * `GraderPack.loadCases()` is what eventually calls this, once per turn it
 * wants graded, and returns the resulting array straight through.
 */

import type { CaseInput } from "../grader/types.js";
import type { TurnRecord } from "./types.js";

/**
 * The shape `turnToCase` wraps a turn's request payload into for
 * `CaseInput.input` — a small, consistent envelope rather than sometimes
 * bare `requestPayload` and sometimes not, depending on whether the caller
 * supplied extra context. `context` is optional and entirely target-
 * specific (CTS.md Session 5: "the exact shape of 'enough context' is
 * target-specific and left to the caller to assemble") — e.g. the source
 * journal entries an InsightReport output is supposed to be grounded in,
 * which a groundedness check (Layer 5) needs something to check the
 * output against beyond the turn's own request/response. This adapter has
 * no opinion on `context`'s own shape — Grader's layers treat `input`
 * opaquely (JSON-stringified into a judge prompt) regardless.
 */
export interface TurnCaseInput {
  requestPayload: unknown;
  context?: unknown;
}

/**
 * Turns one soak `TurnRecord` into a Grader `CaseInput`. `rubricKeyFor` is
 * supplied by the caller (the target's own blueprint/pack, keyed per AI
 * feature/pipeline a turn hit) — this is exactly the seam that keeps
 * target-specific rubric-selection knowledge out of Drover's repo, per ADR
 * 0010. `context`, if given, is threaded into `CaseInput.input` alongside
 * the turn's own `requestPayload` — left entirely to the caller to decide
 * whether and what to supply.
 */
export function turnToCase(
  turn: TurnRecord,
  rubricKeyFor: (turn: TurnRecord) => string,
  context?: unknown,
): CaseInput {
  const input: TurnCaseInput = {
    requestPayload: turn.requestPayload,
    ...(context !== undefined && { context }),
  };
  return {
    input,
    output: turn.responsePayload,
    rubric: rubricKeyFor(turn),
  };
}
