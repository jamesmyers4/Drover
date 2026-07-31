/**
 * Prompt construction for a single-judge scoring call (Grader Session 4).
 * Split from `provider.ts` for the same reason the actor tier splits
 * `prompt.ts` from `provider.ts` — pure string-building, easy to unit test
 * without a real model call.
 *
 * One call scores every Check in the rubric at once (the Check glossary
 * entry: "one Task/one call can score several Checks in a single pass,
 * since loading the Case's input/output is the expensive part, not asking
 * one question vs. several"). `framing` distinguishes Layer 2's golden-
 * regression framing from Layer 3's open LLM-judge framing — the dispatch
 * mechanics are otherwise identical (FUTUREPLAN.md Session 4: "local
 * single-judge layers (2-3)").
 */

import type { Rubric } from "./types.js";

function describeCheck(check: Rubric["checks"][number]): string {
  const scoring =
    check.scoringType === "boolean"
      ? "boolean (true/false)"
      : `numeric (agreement tolerance ±${check.numericTolerance})`;
  return `- "${check.name}" [${scoring}]: ${check.description}`;
}

export function buildScoreSystemPrompt(framing: string, rubric: Rubric): string {
  const checkList = rubric.checks.map(describeCheck).join("\n");
  return [
    framing.trim(),
    "",
    `Rubric: ${rubric.key} — ${rubric.description}`,
    "",
    "Score every Check listed below independently. For each, give its value (matching the",
    "Check's own scoring type exactly — true/false for boolean, a number for numeric) and one",
    "short sentence of reasoning explaining that value.",
    "",
    "Checks:",
    checkList,
    "",
    "Call score_checks with exactly one entry per Check listed above, using the Check's name",
    "verbatim.",
  ].join("\n");
}

export function buildScoreUserPrompt(input: unknown, output: unknown): string {
  return [
    "Input:",
    JSON.stringify(input, null, 2),
    "",
    "Output to grade:",
    JSON.stringify(output, null, 2),
  ].join("\n");
}

/** Layer 2's golden-dataset-regression framing (FUTUREPLAN.md §1.2). */
export const GOLDEN_REGRESSION_FRAMING =
  "You are checking AI-generated output against a curated golden-dataset rubric for regression " +
  "testing. The rubric's Checks describe the expected properties a correct output should have " +
  "for this kind of input, established from prior known-good examples. Judge whether the given " +
  "output still satisfies those expected properties, not whether it's merely plausible.";

/** Layer 3's open single-judge LLM-as-judge framing (FUTUREPLAN.md §1's technique 3). */
export const LLM_JUDGE_FRAMING =
  "You are acting as an independent judge scoring a single AI-generated output against an " +
  "explicit rubric. Judge the output strictly on its own merits against each named criterion — " +
  "do not compare it to any other output, and do not reward verbosity or confident phrasing over " +
  "substance.";
