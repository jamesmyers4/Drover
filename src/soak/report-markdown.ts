/**
 * Markdown rendering for a `SoakReport` (CTS.md Soak Session 7) — mirrors
 * `src/report/markdown.ts`'s own structure/conventions for the simulation
 * stack's report.
 */

import type { ExplicitErrorCluster, SoakReport, TurnVolumeByLane } from "./report.js";
import type { CrossTurnFindingRecord } from "./types.js";

function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function turnsByLaneTable(rows: TurnVolumeByLane[]): string {
  if (rows.length === 0) return "_No turns recorded._";
  const header = "| Lane | Turns | Explicit errors | Gated (402/429) |\n| --- | --- | --- | --- |";
  const body = rows.map(
    (r) => `| ${escapeCell(r.lane)} | ${r.count} | ${r.explicitErrorCount} | ${r.gatedCount} |`,
  );
  return [header, ...body].join("\n");
}

function explicitErrorClustersSection(clusters: ExplicitErrorCluster[]): string {
  if (clusters.length === 0) return "_No explicit errors recorded._";
  const header = "| Count | Error detail | Turn ids (first 5) |\n| --- | --- | --- |";
  const body = clusters.map(
    (c) =>
      `| ${c.count} | ${escapeCell(c.errorDetail)} | ${c.turnIds
        .slice(0, 5)
        .map((id) => `\`${id}\``)
        .join(", ")}${c.turnIds.length > 5 ? ", …" : ""} |`,
  );
  return [header, ...body].join("\n");
}

function crossTurnFindingsTable(findings: CrossTurnFindingRecord[]): string {
  if (findings.length === 0) return "_No cross-turn findings._";
  const header = "| Severity | Type | Description | Turns |\n| --- | --- | --- | --- |";
  const body = findings.map(
    (f) => `| ${f.severity} | ${f.type} | ${escapeCell(f.description)} | ${f.turnIds.length} |`,
  );
  return [header, ...body].join("\n");
}

export function renderSoakReportMarkdown(report: SoakReport): string {
  const sections: string[] = [];

  sections.push(`# Drover Soak Report — ${report.appName}`);
  sections.push(
    `Run \`${report.runId}\` — **${report.status}**\n\n` +
      `Started: ${formatDate(report.startedAt)}  \n` +
      `Ended: ${report.endedAt !== undefined ? formatDate(report.endedAt) : "_in progress_"}`,
  );

  const metadataLines = [
    `- Budget: $${report.budgetCeilingUsd} run ceiling — actual spend $${report.spentUsd.toFixed(4)}`,
    `- Cross-turn analysis spend: $${(report.crossTurnCostUsd ?? 0).toFixed(4)}`,
  ];
  sections.push(["## Run metadata", metadataLines.join("\n")].join("\n\n"));

  sections.push(["## Turn volume by lane", turnsByLaneTable(report.turnsByLane)].join("\n\n"));

  sections.push(
    ["## Explicit-error clusters", explicitErrorClustersSection(report.explicitErrorClusters)].join(
      "\n\n",
    ),
  );

  sections.push(
    ["## Cross-turn findings", crossTurnFindingsTable(report.crossTurnFindings)].join("\n\n"),
  );

  if (report.graderReportMarkdown !== undefined) {
    sections.push(["## Grader-graded findings", report.graderReportMarkdown].join("\n\n"));
  } else if (report.graderUnavailableReason !== undefined) {
    sections.push(
      ["## Grader-graded findings", `_Unavailable: ${report.graderUnavailableReason}._`].join(
        "\n\n",
      ),
    );
  } else {
    sections.push(
      [
        "## Grader-graded findings",
        "_No Grader pass linked to this run — `drover soak analyze` was run without a blueprint that configures `graderIntegration`, per ADR 0010._",
      ].join("\n\n"),
    );
  }

  return `${sections.join("\n\n")}\n`;
}
