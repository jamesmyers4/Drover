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
 *
 * Chunking (GAPS fix): a run's digests are split into groups of at most
 * `sessionsPerChunk` sessions, each sent as its own `provider.analyze()`
 * call (its own independent Batch API request when `provider` is the real
 * `BatchAnalystProvider` — see provider.ts; `custom_id` reuse across
 * separate `batches.create()` calls is fine, it only needs to be unique
 * *within* one call's `requests` array), all issued concurrently via
 * `Promise.all` rather than one call per `drover analyze` invocation
 * covering every session. This keeps any one prompt from growing unbounded
 * with a large run's session count. The real trade-off: cross-session
 * correlation only happens *within* a chunk — a pattern that only shows up
 * by comparing a session in chunk 1 against a session in chunk 2 would be
 * missed, since the model backing each chunk's call never sees the other
 * chunk's digests. `sessionsPerChunk` defaults large enough that this
 * doesn't matter for realistic run sizes; see `DEFAULT_SESSIONS_PER_CHUNK`.
 */

import type { DroverDb } from "../db/database.js";
import { newId } from "../db/database.js";
import { computeMatchKey } from "../matching/match-key.js";
import { type ReconciliationSummary, reconcileRunFindings } from "../orchestrator/reconcile.js";
import type { CrossSessionFinding, InSessionFinding } from "../types/index.js";
import { AnalystBudgetExceededError, estimateAnalystCostUsd } from "./budget.js";
import { buildSessionDigest, type SessionDigest } from "./digest.js";
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

/**
 * Chosen as a round number comfortably larger than any run this v1 has
 * actually been exercised against (toy examples, small simulated orgs) —
 * revisit once a real domain pack's run dimensions (org size × weeks ×
 * frequency) routinely produce more sessions than this in one run.
 */
export const DEFAULT_SESSIONS_PER_CHUNK = 25;

export interface RunAnalystOptions {
  db: DroverDb;
  runId: string;
  /** Defaults to createAnalystProvider(run.config.modelRouting.analyst) — tests inject a ScriptedAnalystProvider. */
  provider?: AnalystProvider;
  pollIntervalMs?: number;
  /**
   * Max sessions per analyst request — splits a large run's digests across
   * multiple concurrent `provider.analyze()` calls instead of one prompt
   * covering every session (see the module doc comment for the trade-off).
   * @default DEFAULT_SESSIONS_PER_CHUNK
   */
  sessionsPerChunk?: number;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (!(size > 0)) {
    throw new Error(`sessionsPerChunk must be a positive number, got ${size}.`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
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
  const sessionsPerChunk = opts.sessionsPerChunk ?? DEFAULT_SESSIONS_PER_CHUNK;
  const digestChunks: SessionDigest[][] = chunkArray(digests, sessionsPerChunk);
  const userPrompts = digestChunks.map((chunk) =>
    buildAnalystUserPrompt(chunk, run.checkpointContext),
  );

  const ceilingUsd = run.config.budget.analystCeilingUsd;
  if (ceilingUsd !== undefined) {
    // The ceiling covers this whole `drover analyze` invocation, not any one
    // chunk — sum every chunk's estimate before submitting any of them, so a
    // run that would only blow the budget once all its chunks are counted
    // still fails closed before a single request goes out.
    const estimates = await Promise.all(
      userPrompts.map((userPrompt) =>
        estimateAnalystCostUsd(
          run.config.modelRouting.analyst.model,
          systemPrompt,
          userPrompt,
          DEFAULT_MAX_TOKENS,
        ),
      ),
    );
    const totalEstimatedCostUsd = estimates.reduce((sum, cost) => sum + cost, 0);
    if (totalEstimatedCostUsd > ceilingUsd) {
      throw new AnalystBudgetExceededError(totalEstimatedCostUsd, ceilingUsd);
    }
  }

  const provider =
    opts.provider ??
    createAnalystProvider(
      run.config.modelRouting.analyst,
      opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : undefined,
    );

  const responses = await Promise.all(
    userPrompts.map((userPrompt) => provider.analyze({ systemPrompt, userPrompt })),
  );

  const knownSessionIds = new Set(sessions.map((s) => s.id));
  let findingsWritten = 0;
  const skippedReasons: string[] = [];

  for (const response of responses) {
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
  }

  const reconciliation = reconcileRunFindings(db, runId, run.appName);

  return {
    runId,
    sessionsAnalyzed: sessions.length,
    findingsWritten,
    findingsSkipped: skippedReasons.length,
    skippedReasons,
    reconciliation,
    costUsd: responses.reduce((sum, r) => sum + r.usage.costUsd, 0),
  };
}
