/**
 * The analyst tier's entry point (CONTEXT.md "Architecture: three tiers" —
 * Analyst; CLAUDE.md Session 5): loads a completed run's sessions/events/
 * in-session findings, builds per-session digests, sends them to the
 * analyst provider (Sonnet via the Batch API in production), validates the
 * structured output, and writes `cross_session_findings` rows.
 *
 * Runs `reconcileRunFindings` again after writing cross-session findings.
 * The orchestrator (Session 4) already reconciles once right after a run
 * finishes, but only in-session findings exist at that point — cross-session
 * findings don't exist until this separate, later command runs. Re-running
 * reconciliation (now upsert-safe, see src/db/database.ts) lets the second,
 * fuller pass correct anything the first pass got wrong (e.g. a
 * cross-session finding's match_key that looked "resolved" in the first
 * pass, before the analyst had a chance to re-detect it).
 */

import type { DroverDb } from "../db/database.js";
import { newId } from "../db/database.js";
import { computeMatchKey } from "../matching/match-key.js";
import { type ReconciliationSummary, reconcileRunFindings } from "../orchestrator/reconcile.js";
import type { CrossSessionFinding, InSessionFinding } from "../types/index.js";
import { AnalystBudgetExceededError, estimateAnalystCostUsd } from "./budget.js";
import { buildSessionDigest } from "./digest.js";
import { buildAnalystSystemPrompt, buildAnalystUserPrompt } from "./prompt.js";
import { type AnalystProvider, createAnalystProvider, DEFAULT_MAX_TOKENS } from "./provider.js";
import { isValidationError, validateRawFinding } from "./validate.js";

export { AnalystBudgetExceededError } from "./budget.js";

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`No run found with id "${runId}".`);
    this.name = "RunNotFoundError";
  }
}

export interface RunAnalystOptions {
  db: DroverDb;
  runId: string;
  /** Defaults to createAnalystProvider(run.config.modelRouting.analyst) — tests inject a ScriptedAnalystProvider. */
  provider?: AnalystProvider;
  pollIntervalMs?: number;
}

export interface RunAnalystResult {
  runId: string;
  sessionsAnalyzed: number;
  findingsWritten: number;
  findingsSkipped: number;
  skippedReasons: string[];
  reconciliation: ReconciliationSummary;
  costUsd: number;
}

/** Best-effort representative evidence for a cross-session finding, borrowed from one of its sessions' own in-session findings — the analyst has no live browser to capture new screenshots (CONTEXT.md "Visual evidence"). */
function findRepresentativeEvidence(
  db: DroverDb,
  sessionIds: string[],
): Pick<InSessionFinding, "screenshotPath" | "traceSnippet"> {
  for (const sessionId of sessionIds) {
    for (const finding of db.getInSessionFindingsBySession(sessionId)) {
      if (finding.screenshotPath) {
        return {
          screenshotPath: finding.screenshotPath,
          ...(finding.traceSnippet !== undefined && { traceSnippet: finding.traceSnippet }),
        };
      }
    }
  }
  return {};
}

export async function runAnalyst(opts: RunAnalystOptions): Promise<RunAnalystResult> {
  const { db, runId } = opts;
  const run = db.getRun(runId);
  if (!run) throw new RunNotFoundError(runId);

  const sessions = db.getSessionsByRun(runId);
  const emptyResult: RunAnalystResult = {
    runId,
    sessionsAnalyzed: 0,
    findingsWritten: 0,
    findingsSkipped: 0,
    skippedReasons: [],
    reconciliation: { new: 0, stillOpen: 0, resolved: 0 },
    costUsd: 0,
  };
  if (sessions.length === 0) return emptyResult;

  const digests = sessions.map((s) => buildSessionDigest(db, s));
  const systemPrompt = buildAnalystSystemPrompt();
  const userPrompt = buildAnalystUserPrompt(digests);

  const ceilingUsd = run.config.budget.analystCeilingUsd;
  if (ceilingUsd !== undefined) {
    const estimatedCostUsd = estimateAnalystCostUsd(
      run.config.modelRouting.analyst.model,
      systemPrompt,
      userPrompt,
      DEFAULT_MAX_TOKENS,
    );
    if (estimatedCostUsd > ceilingUsd) {
      throw new AnalystBudgetExceededError(estimatedCostUsd, ceilingUsd);
    }
  }

  const provider =
    opts.provider ??
    createAnalystProvider(
      run.config.modelRouting.analyst,
      opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : undefined,
    );

  const response = await provider.analyze({ systemPrompt, userPrompt });

  const knownSessionIds = new Set(sessions.map((s) => s.id));
  let findingsWritten = 0;
  const skippedReasons: string[] = [];

  for (const raw of response.findings) {
    const validated = validateRawFinding(raw, knownSessionIds);
    if (isValidationError(validated)) {
      skippedReasons.push(validated.error);
      console.error(
        `[drover] analyst: skipping malformed finding for run ${runId} — ${validated.error}`,
      );
      continue;
    }

    const matchKey = computeMatchKey(validated.type, validated.route);
    const evidence = findRepresentativeEvidence(db, validated.sessionIds);
    const finding: CrossSessionFinding = {
      id: newId(),
      runId,
      type: validated.type,
      severity: validated.severity,
      description: validated.description,
      sessionIds: validated.sessionIds,
      matchKey,
      ...evidence,
      createdAt: Date.now(),
    };
    db.insertCrossSessionFinding(finding);
    findingsWritten++;
  }

  const reconciliation = reconcileRunFindings(db, runId, run.appName);

  return {
    runId,
    sessionsAnalyzed: sessions.length,
    findingsWritten,
    findingsSkipped: skippedReasons.length,
    skippedReasons,
    reconciliation,
    costUsd: response.usage.costUsd,
  };
}
