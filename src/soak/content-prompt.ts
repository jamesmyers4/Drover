/**
 * Prompt construction for the local driver's "lightly vary this example"
 * call (CTS.md Soak Session 4; ADR 0009). Split from `content-provider.ts`
 * for the same reason the actor tier splits `prompt.ts` from `provider.ts`
 * and Grader splits its own `prompt.ts` — pure string-building, easy to unit
 * test without a real model call.
 *
 * The framing is deliberately narrow: ADR 0009 draws a hard line between
 * "vary pre-written content" and "author new content" — the prompt exists
 * to keep the driver on the varying side of that line, not to give it
 * open-ended creative latitude.
 */

import type { VariationParams } from "./types.js";

function describeConstraints(variation: VariationParams | undefined): string[] {
  const constraints: string[] = [];
  if (variation?.wordSubstitutionRate !== undefined) {
    constraints.push(
      `Substitute roughly ${Math.round(variation.wordSubstitutionRate * 100)}% of the words with a synonym or near-equivalent phrase — the rest should stay as written.`,
    );
  }
  if (variation?.targetLengthChars !== undefined) {
    constraints.push(
      `Aim for a final length between ${variation.targetLengthChars.min} and ${variation.targetLengthChars.max} characters (trim or pad by adding/removing incidental detail, not new plot points).`,
    );
  }
  if (variation?.allowDetailReordering) {
    constraints.push("You may reorder independent narrative details or sentences.");
  } else {
    constraints.push("Keep sentences and details in their original order.");
  }
  return constraints;
}

export function buildVarySystemPrompt(variation: VariationParams | undefined): string {
  return [
    "You are lightly varying a pre-written example narrative for a software testing tool.",
    "The narrative was authored in advance by a human. You must NOT invent new scenarios, facts,",
    "names, numbers, or events, and must NOT change what actually happened in it — only vary the",
    "wording and phrasing (and, if permitted below, sentence order) so repeated test runs don't",
    "send byte-identical text every time.",
    "",
    "Constraints:",
    ...describeConstraints(variation).map((c) => `- ${c}`),
    "",
    "Call vary_narrative with the varied text.",
  ].join("\n");
}

export function buildVaryUserPrompt(exampleText: string): string {
  return `Example narrative to vary:\n${exampleText}`;
}
