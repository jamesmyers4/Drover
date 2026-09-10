/**
 * Markdown rendering for a GradingReport (FUTUREPLAN.md Grader Session 6) —
 * Grader's own analogue of `src/report/markdown.ts`'s `renderMarkdownReport`.
 * A distinct file from the CI JSON summary (Grader Session 7, per Q14) —
 * this is the human-facing deliverable; that one is machine-facing.
 */

import type { GradingReport, GradingReportCaseRow, GradingReportLayerCell } from "./report.js";
import type { CheckResult, LayerId, Rubric, TaskStatus } from "./types.js";

const ALL_LAYER_IDS: LayerId[] = [1, 2, 3, 4, 5, 6, 7];

function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** "pass"/"fail"/"skipped" render as their own distinct labels — skipped is never folded into "not a pass" (Q5's guardrail, carried through to the report). "–" means the layer never dispatched a Task for this Case at all (not implemented/disabled this run, distinct from a genuine skip). */
function layerCellLabel(cell: GradingReportLayerCell | undefined): string {
  if (!cell) return "–";
  const labels: Record<TaskStatus, string> = {
    pending: "pending",
    running: "running",
    pass: "pass",
    fail: "fail",
    skipped: "skipped",
  };
  return labels[cell.status];
}

function casesTable(cases: GradingReportCaseRow[]): string {
  if (cases.length === 0) return "_No Cases processed._";
  const header =
    `| Case | Rubric | ${ALL_LAYER_IDS.map((id) => `L${id}`).join(" | ")} | Escalations | Skips |\n` +
    `| --- | --- | ${ALL_LAYER_IDS.map(() => "---").join(" | ")} | --- | --- |`;
  const body = cases.map((row) => {
    const layerCells = ALL_LAYER_IDS.map((id) => layerCellLabel(row.layers[id])).join(" | ");
    return `| \`${row.caseId}\` | ${escapeCell(row.rubricKey)} | ${layerCells} | ${row.escalationCount} | ${row.skipCount} |`;
  });
  return [header, ...body].join("\n");
}

function checksList(checks: CheckResult[]): string {
  if (checks.length === 0) return "_No Checks recorded._";
  return checks
    .map(
      (check) => `  - **${check.name}**: \`${JSON.stringify(check.value)}\` — ${check.reasoning}`,
    )
    .join("\n");
}

function caseDetailSection(row: GradingReportCaseRow): string {
  const lines = [`### Case \`${row.caseId}\` — rubric \`${row.rubricKey}\``];
  lines.push(`Escalations: ${row.escalationCount} | Skips: ${row.skipCount}`);
  lines.push("");
  lines.push(`Input: \`${escapeCell(JSON.stringify(row.input))}\``);
  lines.push(`Output: \`${escapeCell(JSON.stringify(row.output))}\``);

  for (const layerId of ALL_LAYER_IDS) {
    const cell = row.layers[layerId];
    if (!cell) continue;
    lines.push("");
    lines.push(`**Layer ${layerId}: ${cell.status}**`);
    if (cell.status === "skipped" && cell.skippedReason !== undefined) {
      lines.push(`  - Skipped because: ${cell.skippedReason}`);
    } else {
      lines.push(checksList(cell.checks));
    }
  }
  return lines.join("\n");
}

function describeRubricCheck(check: Rubric["checks"][number]): string {
  if (check.scoringType === "boolean") {
    return `- **${check.name}** [boolean]: ${check.description}`;
  }
  return (
    `- **${check.name}** [numeric, agreement tolerance ±${check.numericTolerance}, ` +
    `pass when ${check.passThreshold.comparison} ${check.passThreshold.value}]: ${check.description}`
  );
}

function rubricsUsedSection(rubricsUsed: GradingReport["rubricsUsed"]): string {
  const keys = Object.keys(rubricsUsed).sort();
  if (keys.length === 0) return "_No rubrics referenced by any Case in this run._";
  return keys
    .map((key) => {
      const snapshot = rubricsUsed[key];
      if (!snapshot) return "";
      const checks = snapshot.content.checks.map(describeRubricCheck).join("\n");
      return (
        `### \`${key}\` (content hash \`${snapshot.contentHash.slice(0, 12)}\`)\n\n` +
        `${escapeCell(snapshot.content.description)}\n\n${checks}`
      );
    })
    .join("\n\n");
}

export function renderGradingReportMarkdown(report: GradingReport): string {
  const sections: string[] = [];

  sections.push(`# Grading Report — ${report.appName}`);
  sections.push(
    `Grading Run \`${report.gradingRunId}\` — **${report.status}**\n\n` +
      `Started: ${formatDate(report.startedAt)}  \n` +
      `Ended: ${report.endedAt !== undefined ? formatDate(report.endedAt) : "_in progress_"}`,
  );

  const { packConfig } = report;
  const metadataLines = [
    `- dataPolicy: ${packConfig.dataPolicy}`,
    `- allowHostedEscalation: ${packConfig.allowHostedEscalation ?? false}`,
    ...(packConfig.graderCeilingUsd !== undefined
      ? [`- graderCeilingUsd: $${packConfig.graderCeilingUsd}`]
      : []),
    `- Cases processed: ${report.casesProcessed}`,
    `- Tasks — pass: ${report.tasksPassed}, fail: ${report.tasksFailed}, skipped: ${report.tasksSkipped}`,
    `- Total escalations: ${report.totalEscalations}`,
  ];
  sections.push(["## Run summary", metadataLines.join("\n")].join("\n\n"));

  sections.push(
    [
      "## Cases",
      "Sorted by escalation count, then skip count, descending — Cases most likely to need attention first.",
      casesTable(report.cases),
    ].join("\n\n"),
  );

  sections.push(
    [
      "## Case detail",
      report.cases.length === 0
        ? "_No Cases processed._"
        : report.cases.map(caseDetailSection).join("\n\n"),
    ].join("\n\n"),
  );

  sections.push(["## Rubrics used", rubricsUsedSection(report.rubricsUsed)].join("\n\n"));

  return `${sections.join("\n\n")}\n`;
}
