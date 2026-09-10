/**
 * Cross-turn pattern mining (CTS.md Soak Session 6; ADR 0008) — the pass
 * Grader structurally can't do, since a Grader `Case` is a single
 * `{input, output, rubric}` triple with no mechanism to compare two
 * different Cases. Architecturally mirrors the Analyst tier's chunked-
 * digest/Batch-API/map-reduce shape (`src/analyst/analyze.ts`), not a
 * literal reuse — a turn isn't a session.
 *
 * Two independent sources of findings, merged into one result:
 * - The LLM-backed pass (`disagreement`/`drift`/`recurring-error-cluster`),
 *   one `provider.analyze()` call per chunk, issued concurrently via
 *   `Promise.all` — same map-reduce shape `runAnalyst` already uses.
 *   Cross-chunk correlation gap accepted (a pattern spanning two different
 *   chunks would be missed) — same known trade-off the Analyst tier already
 *   carries and documents.
 * - Deterministic timing-anomaly detection, reusing `src/stampede/
 *   metrics.ts`'s `percentile` function directly — no new statistics code,
 *   no LLM call, computed once over every turn regardless of chunking.
 */

import { percentile } from "../stampede/metrics.js";
import { buildCrossTurnSystemPrompt, buildCrossTurnUserPrompt } from "./cross-turn-prompt.js";
import { BatchCrossTurnProvider, type CrossTurnProvider } from "./cross-turn-provider.js";
import { isCrossTurnValidationError, validateRawCrossTurnFinding } from "./cross-turn-validate.js";
import { buildTurnDigest, chunkArray, DEFAULT_TURNS_PER_CHUNK, type TurnDigest } from "./digest.js";
import type { CrossTurnFinding, TurnRecord } from "./types.js";

/**
 * A lane's response-time p99 must be at least this many times its p50
 * before it's flagged as an anomaly — a simple, explicitly-flagged guess
 * (not derived from real run data yet), same "pick something reasonable,
 * flag it, revisit later" precedent `DEFAULT_TURNS_PER_CHUNK`/
 * `DEFAULT_SESSIONS_PER_CHUNK` already set for their own guessed constants.
 */
export const TIMING_ANOMALY_P99_TO_P50_RATIO = 3;

/** Below this many timed samples in a lane, percentile math is too noisy to trust — avoids a false positive off 2-3 samples. Also a guess, flagged. */
export const MIN_SAMPLES_FOR_TIMING_ANOMALY = 5;

/** Groups every digest with a known `responseTimeMs` by lane — turns with no response time (e.g. a variation failure that never reached HTTP dispatch) are excluded, not treated as 0ms. */
function groupTimingsByLane(digests: TurnDigest[]): Map<string, { turnId: string; ms: number }[]> {
  const byLane = new Map<string, { turnId: string; ms: number }[]>();
  for (const d of digests) {
    if (d.responseTimeMs === undefined) continue;
    const entry = { turnId: d.turnId, ms: d.responseTimeMs };
    const existing = byLane.get(d.lane);
    if (existing) existing.push(entry);
    else byLane.set(d.lane, [entry]);
  }
  return byLane;
}

/**
 * Deterministic, LLM-free timing-anomaly detection (CTS.md Session 6 item
 * 3) — flags a lane whose response-time distribution has a long tail
 * (`p99 >= p50 * TIMING_ANOMALY_P99_TO_P50_RATIO`). `turnIds` on the
 * resulting finding are the specific outlier turns (at or above that lane's
 * own p99), not every turn in the lane — a more useful pointer for a human
 * reviewing the finding than "all N turns in this lane."
 */
export function detectTimingAnomalies(digests: TurnDigest[]): CrossTurnFinding[] {
  const findings: CrossTurnFinding[] = [];
  for (const [lane, entries] of groupTimingsByLane(digests)) {
    if (entries.length < MIN_SAMPLES_FOR_TIMING_ANOMALY) continue;

    const sorted = [...entries].sort((a, b) => a.ms - b.ms);
    const durations = sorted.map((e) => e.ms);
    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);
    if (p50 <= 0 || p99 < p50 * TIMING_ANOMALY_P99_TO_P50_RATIO) continue;

    findings.push({
      type: "timing-anomaly",
      severity: "medium",
      description:
        `Lane "${lane}" shows a long response-time tail across ${entries.length} timed turns: ` +
        `p50=${p50}ms, p95=${p95}ms, p99=${p99}ms (p99/p50 ratio ${(p99 / p50).toFixed(1)}x).`,
      turnIds: sorted.filter((e) => e.ms >= p99).map((e) => e.turnId),
    });
  }
  return findings;
}

export interface RunCrossTurnAnalysisOptions {
  turns: TurnRecord[];
  /** Defaults to a real `BatchCrossTurnProvider` — tests inject a `ScriptedCrossTurnProvider`. */
  provider?: CrossTurnProvider;
  /** @default DEFAULT_TURNS_PER_CHUNK */
  turnsPerChunk?: number;
}

export interface RunCrossTurnAnalysisResult {
  turnsAnalyzed: number;
  findings: CrossTurnFinding[];
  findingsSkipped: number;
  skippedReasons: string[];
  costUsd: number;
}

/**
 * Runs the full cross-turn pass over a batch of turns (typically one soak
 * run's worth, per `drover soak analyze` — Session 7's job to call this).
 * Turns are chunked, one LLM call per chunk dispatched concurrently, raw
 * findings validated and malformed ones skipped-and-logged (never crashing
 * the pass), then merged with the deterministic timing-anomaly findings
 * computed once across every turn regardless of chunk boundaries (timing
 * anomalies don't have the Analyst tier's cross-chunk correlation gap,
 * since `percentile` math doesn't need an LLM's context window).
 */
export async function runCrossTurnAnalysis(
  opts: RunCrossTurnAnalysisOptions,
): Promise<RunCrossTurnAnalysisResult> {
  const { turns } = opts;
  if (turns.length === 0) {
    return { turnsAnalyzed: 0, findings: [], findingsSkipped: 0, skippedReasons: [], costUsd: 0 };
  }

  const digests = turns.map(buildTurnDigest);
  const turnsPerChunk = opts.turnsPerChunk ?? DEFAULT_TURNS_PER_CHUNK;
  const chunks = chunkArray(digests, turnsPerChunk);
  const systemPrompt = buildCrossTurnSystemPrompt();
  const userPrompts = chunks.map((chunk) => buildCrossTurnUserPrompt(chunk));

  const provider = opts.provider ?? new BatchCrossTurnProvider();
  const responses = await Promise.all(
    userPrompts.map((userPrompt) => provider.analyze({ systemPrompt, userPrompt })),
  );

  const knownTurnIds = new Set(turns.map((t) => t.id));
  const findings: CrossTurnFinding[] = [];
  const skippedReasons: string[] = [];

  for (const response of responses) {
    for (const raw of response.findings) {
      const validated = validateRawCrossTurnFinding(raw, knownTurnIds);
      if (isCrossTurnValidationError(validated)) {
        skippedReasons.push(validated.error);
        console.error(`[drover] soak cross-turn: skipping malformed finding — ${validated.error}`);
        continue;
      }
      findings.push(validated);
    }
  }

  findings.push(...detectTimingAnomalies(digests));

  const costUsd = responses.reduce((sum, r) => sum + r.usage.costUsd, 0);

  return {
    turnsAnalyzed: turns.length,
    findings,
    findingsSkipped: skippedReasons.length,
    skippedReasons,
    costUsd,
  };
}
