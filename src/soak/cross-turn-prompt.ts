/**
 * Prompt assembly for the cross-turn pass (CTS.md Soak Session 6) —
 * architecturally mirrors the Analyst tier's `prompt.ts` (a single post-hoc
 * call over a batch of digests, no caching, no streaming), not a literal
 * reuse (ADR 0008: a turn isn't a session, so the digest shape and the
 * pattern categories are both genuinely different).
 */

import type { TurnDigest } from "./digest.js";

export function buildCrossTurnSystemPrompt(): string {
  return [
    "You are the cross-turn analysis pass of Drover's Soak mode, a long-running continuous-execution testing mode. You are given digests of a batch of turns from a single soak run — each turn was one dispatched request/response against the target, built from a pre-authored example that was lightly varied before dispatch.",
    "Your job is to find patterns visible only across turns, that no single turn's own explicit-error check would notice on its own:",
    "- disagreement: two or more turns whose requests describe the same underlying record or situation but whose responses tell contradictory stories about it.",
    "- drift: turns sharing the same variationId (the same underlying selected example, just lightly varied wording) whose responses diverge meaningfully over the run — not merely different wording, but a real change in what the response asserts.",
    "- recurring-error-cluster: several turns with explicitError=true whose errorDetail looks like the same underlying root cause, worth grouping into one finding rather than reporting as separate incidents.",
    "Do not report a timing or performance observation — that's handled separately by deterministic percentile math, not this pass.",
    "Only report a pattern that's actually visible across two or more of the provided turns, or a single occurrence severe enough to merit flagging on its own (e.g. a data-integrity contradiction). Do not invent a pattern from one unremarkable turn.",
    'For each finding, set "turnIds" to the turn ids (from the digests below) exhibiting the pattern.',
    "Respond only through the report_cross_turn_findings tool. If nothing rises to a genuine cross-turn pattern, return an empty findings array — do not force a finding to have something to report.",
  ].join("\n\n");
}

function formatDigest(d: TurnDigest): string {
  const lines = [
    `Turn ${d.turnId} — sequence ${d.sequence}, lane ${d.lane}, variationId ${d.variationId}`,
    `explicitError: ${d.explicitError}${d.errorDetail !== undefined ? ` (${d.errorDetail})` : ""}`,
  ];
  if (d.httpStatus !== undefined) lines.push(`httpStatus: ${d.httpStatus}`);
  if (d.responseTimeMs !== undefined) lines.push(`responseTimeMs: ${d.responseTimeMs}`);
  lines.push(`request: ${d.requestSummary}`);
  lines.push(`response: ${d.responseSummary ?? "(none)"}`);
  return lines.join("\n");
}

export function buildCrossTurnUserPrompt(digests: TurnDigest[]): string {
  const blocks = digests.map(formatDigest);
  return `Turn digests for this batch (${digests.length} turn(s)):\n\n${blocks.join("\n\n---\n\n")}`;
}
