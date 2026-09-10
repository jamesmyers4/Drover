/**
 * Default judge routing for a `GraderPack` when no explicit `GraderModelRouting`
 * is supplied — extracted from `src/cli/index.ts`'s `gradeCommand` (Grader
 * Sessions 6-8) so a second caller (`drover soak analyze`, CTS.md Soak
 * Session 7) doesn't have to re-derive the same "which judges are actually
 * safe/available to use" decision. Picks local Ollama alone when hosted
 * dispatch isn't permitted (ADR 0002) or no Anthropic key is configured;
 * adds Anthropic as a second judge + escalation route otherwise, enabling
 * Layers 4-7's Consensus Round (ADR 0003's >= 2 distinct-model-family
 * requirement).
 */

import type { GraderModelRouting } from "./grade.js";
import { DEFAULT_GRADER_OLLAMA_MODEL, DEFAULT_HOSTED_GRADER_MODEL } from "./provider.js";
import type { GraderPack } from "./types.js";

/**
 * Layers 2-3 always dispatch to the local Ollama model
 * (`DEFAULT_GRADER_OLLAMA_MODEL`) — the "$0 by design" routine-work judge
 * (FUTUREPLAN.md's cost-basis note).
 *
 * Layers 4-7 (multi-judge Consensus Round) need >= 2 distinct-model-family
 * judges plus an escalation route (ADR 0003) — most fresh installs have only
 * one local model pulled, so the second judge comes from Anthropic instead,
 * *when it's actually usable*: an `ANTHROPIC_API_KEY` is present in the
 * environment, and the pack's own `dataPolicy`/`allowHostedEscalation` would
 * allow a hosted dispatch in the first place (mirrors
 * `assertHostedGraderDispatchAllowed`'s own rule, checked here rather than
 * by catching its throw, so an unusable pack degrades to "just Layers 1-3"
 * the same graceful way as having no second judge at all — never a crashed
 * invocation over a caller's own default choice). Ollama does the routine
 * per-Case judging (one of the two Consensus votes, alongside Layers 2-3's
 * single-judge work); Anthropic (`DEFAULT_HOSTED_GRADER_MODEL`) supplies the
 * second, independent vote and doubles as the escalation adjudicator — a
 * real second opinion from the paid model specifically when the two
 * disagree, not a per-Case cost. Escalation is the rare path (Q10) — this
 * keeps real dollar spend small by design. When neither condition holds,
 * Layers 4-7 are left out entirely (a console warning, not an error) — see
 * GAPS.md's 2026-09-09 entries for the fuller history of this gap.
 */
export function defaultGraderRouting(
  pack: Pick<GraderPack, "dataPolicy" | "allowHostedEscalation">,
): GraderModelRouting {
  const ollamaJudge = { provider: "ollama", model: DEFAULT_GRADER_OLLAMA_MODEL };
  const hostedDispatchAllowed =
    pack.dataPolicy !== "restricted" || pack.allowHostedEscalation === true;
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);

  if (!hostedDispatchAllowed || !hasAnthropicKey) {
    return { singleJudge: ollamaJudge, consensusJudges: [] };
  }

  const anthropicJudge = { provider: "anthropic", model: DEFAULT_HOSTED_GRADER_MODEL };
  return {
    singleJudge: ollamaJudge,
    consensusJudges: [ollamaJudge, anthropicJudge],
    escalation: anthropicJudge,
  };
}
