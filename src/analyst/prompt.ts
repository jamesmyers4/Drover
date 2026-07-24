/**
 * Prompt assembly for the analyst tier (CONTEXT.md "Architecture: three
 * tiers" — Analyst; CLAUDE.md Session 5). Unlike the actor tier, this is a
 * single post-hoc call over the whole run's session digests — no prompt
 * caching (nothing repeats within one analyst call), no streaming.
 */

import type { SessionDigest } from "./digest.js";

export function buildAnalystSystemPrompt(): string {
  return [
    "You are the analyst tier of Drover, a QA simulation harness. You are given digests of every persona-session from a single completed simulation run — each session was an independent simulated user exploring a web app and pursuing a goal.",
    "Your job is to find patterns visible only across sessions, that no single session's actor would have noticed on its own:",
    "- duplicate-label: the same or near-duplicate UI label/copy showing up in confusingly repetitive ways across the app.",
    "- repeated-stumble-route: a route or flow that multiple independent sessions got stuck on, retried, or failed at.",
    "- slow-checkpoint: a checkpoint that's technically reachable but took an abnormally long time in some sessions compared to other sessions that reached the same checkpoint id (compare each session's \"Checkpoint reach times\" for matching checkpoint ids), or a goal that took an abnormally high action count in some sessions compared to others attempting the same goal.",
    "- recurring-dead-end: a page or action that repeatedly leads nowhere useful across sessions.",
    "Only report a pattern that's actually visible across two or more of the provided sessions, or is a single occurrence severe enough to merit flagging on its own (e.g. a hard-stop tied to a real bug). Do not invent a pattern from one unremarkable session.",
    'For each finding, set "route" to the specific route, label text, or checkpoint the pattern is anchored to — this becomes the finding\'s identity across future runs, so keep it specific and stable (e.g. a path like "/schedule/edit", not a vague phrase).',
    "Respond only through the report_cross_session_findings tool. If nothing rises to a genuine cross-session pattern, return an empty findings array — do not force a finding to have something to report.",
  ].join("\n\n");
}

export function buildAnalystUserPrompt(digests: SessionDigest[]): string {
  const blocks = digests.map((d) => formatDigest(d));
  return `Session digests for this run (${digests.length} session(s)):\n\n${blocks.join("\n\n---\n\n")}`;
}

function formatDigest(d: SessionDigest): string {
  const metrics = [
    `${d.actionCount} action(s)`,
    d.totalDurationMs !== undefined ? `total duration ${d.totalDurationMs}ms` : undefined,
    d.timeToFirstActionMs !== undefined
      ? `time to first action ${d.timeToFirstActionMs}ms`
      : undefined,
    d.longestGapMs !== undefined ? `longest gap between actions ${d.longestGapMs}ms` : undefined,
  ].filter((s): s is string => s !== undefined);

  const lines = [
    `Session ${d.sessionId} — persona ${d.personaId}, goal ${d.goalId}, status: ${d.status}`,
    metrics.join(", "),
  ];

  const checkpointIds = Object.keys(d.checkpointReachTimesMs);
  if (checkpointIds.length > 0) {
    const reachLines = checkpointIds
      .map((id) => `  - ${id}: ${d.checkpointReachTimesMs[id]}ms`)
      .join("\n");
    lines.push(`Checkpoint reach times (elapsed ms from session start):\n${reachLines}`);
  }

  if (d.findingsSummary.length > 0) {
    lines.push(`In-session findings:\n${d.findingsSummary.map((f) => `  - ${f}`).join("\n")}`);
  } else {
    lines.push("In-session findings: none");
  }

  lines.push(
    d.actionsSummary.length > 0
      ? `Action trace:\n${d.actionsSummary.map((a) => `  ${a}`).join("\n")}`
      : "Action trace: (no actions logged)",
  );

  return lines.join("\n");
}
