/**
 * Markdown rendering for a RunReport (CLAUDE.md Session 6). Findings link to
 * evidence (screenshot paths, event ids) in a separate appendix rather than
 * inlining screenshots/trace text into the summary tables — CONTEXT.md
 * "Visual evidence" keeps captured evidence exactly where you'd look for it,
 * not duplicated into every table row.
 */

import type { FindingReportRow, RunReport, StampedeRunReportSection } from "./report.js";

function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function findingsTable(rows: FindingReportRow[]): string {
  if (rows.length === 0) return "_No findings._";
  const header =
    "| Severity | Type | Description | Sessions | Status |\n| --- | --- | --- | --- | --- |";
  const body = rows.map(
    (row) =>
      `| ${row.severity} | ${row.type} | ${escapeCell(row.description)} | ${row.sessionIds.length} | ${row.status} |`,
  );
  return [header, ...body].join("\n");
}

function evidenceAppendix(rows: FindingReportRow[]): string {
  const withEvidence = rows.filter(
    (row) => row.evidence.screenshotPath !== undefined || row.evidence.eventIds.length > 0,
  );
  if (withEvidence.length === 0) return "_No captured evidence for this run._";
  return withEvidence
    .map((row) => {
      const lines = [`### \`${row.matchKey}\``];
      if (row.evidence.screenshotPath !== undefined) {
        lines.push(`- Screenshot: \`${row.evidence.screenshotPath}\``);
      }
      if (row.evidence.eventIds.length > 0) {
        lines.push(`- Event ids: ${row.evidence.eventIds.map((id) => `\`${id}\``).join(", ")}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatErrorRate(errorCount: number, sampleCount: number): string {
  if (sampleCount === 0) return "0.0%";
  return `${((errorCount / sampleCount) * 100).toFixed(1)}%`;
}

function stampedeRunSection(run: StampedeRunReportSection): string {
  const header = `### Stampede run \`${run.stampedeRunId}\` — concurrency levels ${run.concurrencyLevels.join(", ")}`;
  const meta =
    `Started: ${formatDate(run.startedAt)}  \n` +
    `Ended: ${run.endedAt !== undefined ? formatDate(run.endedAt) : "_in progress_"}`;
  if (run.results.length === 0) {
    return [header, meta, "_No route results recorded._"].join("\n\n");
  }
  const tableHeader =
    "| Route | Concurrency | Samples | Errors | Error rate | p50 (ms) | p95 (ms) | p99 (ms) |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const tableBody = run.results.map(
    (r) =>
      `| ${escapeCell(r.route)} | ${r.concurrency} | ${r.sampleCount} | ${r.errorCount} | ${formatErrorRate(r.errorCount, r.sampleCount)} | ${r.p50Ms.toFixed(0)} | ${r.p95Ms.toFixed(0)} | ${r.p99Ms.toFixed(0)} |`,
  );
  return [header, meta, [tableHeader, ...tableBody].join("\n")].join("\n\n");
}

function stampedeSection(runs: StampedeRunReportSection[]): string {
  if (runs.length === 0) {
    return "_No Stampede (load test) runs recorded against this discovery run._";
  }
  return runs.map(stampedeRunSection).join("\n\n");
}

export function renderMarkdownReport(report: RunReport): string {
  const sections: string[] = [];

  sections.push(`# Drover Report — ${report.appName}`);
  sections.push(
    `Run \`${report.runId}\` — **${report.status}**\n\n` +
      `Started: ${formatDate(report.startedAt)}  \n` +
      `Ended: ${report.endedAt !== undefined ? formatDate(report.endedAt) : "_in progress_"}`,
  );

  const { runDimensions, budget } = report;
  const metadataLines = [
    `- Dimensions: org size ${runDimensions.orgSize}, ${runDimensions.simulatedWeeks} simulated week(s), ${runDimensions.sessionsPerPersonaPerWeek} session(s)/persona/week`,
    `- Actor budget: $${budget.runCeilingUsd} run ceiling — actual spend $${(report.actorCostUsd ?? 0).toFixed(4)}`,
    `- Per-session soft cap: $${budget.perSessionSoftCapUsd}`,
  ];
  if (budget.analystCeilingUsd !== undefined) {
    metadataLines.push(
      `- Analyst budget: $${budget.analystCeilingUsd} ceiling — actual spend $${(report.analystCostUsd ?? 0).toFixed(4)}`,
    );
  } else if (report.analystCostUsd !== undefined) {
    metadataLines.push(
      `- Analyst spend: $${report.analystCostUsd.toFixed(4)} (no ceiling configured)`,
    );
  }
  sections.push(["## Run metadata", metadataLines.join("\n")].join("\n\n"));

  if (!report.hasAnalystPass) {
    sections.push(
      "> **No analyst pass yet.** Cross-session findings and their status may be incomplete until `drover analyze` runs for this run.",
    );
  }

  sections.push(["## Findings summary", findingsTable(report.findings)].join("\n\n"));

  const flowIds = Object.keys(report.findingsByFlow).sort();
  const flowBody =
    flowIds.length === 0
      ? "_No findings attributable to a specific flow._"
      : flowIds
          .map(
            (goalId) =>
              `### Goal: \`${goalId}\`\n\n${findingsTable(report.findingsByFlow[goalId] ?? [])}`,
          )
          .join("\n\n");
  sections.push(["## Findings by flow", flowBody].join("\n\n"));

  sections.push(
    [
      "## Since last run",
      `- ${report.reconciliation.new} new`,
      `- ${report.reconciliation.stillOpen} still open`,
      `- ${report.reconciliation.resolved} resolved`,
    ].join("\n"),
  );

  sections.push(
    ["## Load test results (Stampede)", stampedeSection(report.stampedeRuns)].join("\n\n"),
  );

  sections.push(["## Evidence", evidenceAppendix(report.findings)].join("\n\n"));

  return `${sections.join("\n\n")}\n`;
}
