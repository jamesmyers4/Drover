# Soak analysis splits across Grader (single-turn) and an Analyst-shaped pass (cross-turn), gated on Grader finishing

**Status:** accepted

CTS.md's Phase 3 left open whether the end-of-run analysis pass becomes a new Grader mode or a separate batch-analysis pass. Neither answer alone fits. Grader's `Case` is a single `{input, output, rubric}` triple — it has no mechanism to compare two different Cases, so it structurally cannot see "ToneEval and InsightReport are telling contradictory stories about the same entry" or "response times are drifting across the run." Those are exactly the shape of problem Drover's Analyst tier already solves — chunked cross-session pattern mining via Sonnet Batch API — just for sessions, not turns.

**Decided:** two passes, not one.

- **Single-turn content judging** (guardrail leaks, ungrounded claims, unwarranted certainty) reuses Grader as-is: a turn becomes a `Case` via a generic, target-agnostic adapter (Soak Session 5), graded against whatever rubric the target's own `GraderPack` supplies (see ADR 0010 on where that pack lives). No second judging engine gets invented.
- **Cross-turn pattern mining** (pipeline disagreement, drift, timing anomalies, recurring failure clusters) is a new pass architecturally mirroring the Analyst tier's chunked-digest/Batch-API/map-reduce shape (Soak Session 6) — not a literal reuse of `sessions`/`action_events`-shaped code, since a turn isn't a session. It reuses `src/stampede/metrics.ts`'s percentile math directly for the timing-anomaly half, rather than re-deriving it.

**Consequence — real sequencing dependency:** as of this decision, Grader has only Layers 1–3 and Consensus built (Sessions 1–5); Layer 5 (faithfulness/groundedness — needed for "InsightReport drifted from its source entries"), the full layer tie-together (`runGrading`), and the report/CLI are Grader Sessions 6–8, not yet built. Soak Session 5 (the Grader-Case adapter) is explicitly blocked on Grader Session 8 landing first. Everything else in the Soak blueprint (schema, execution loop, turn logging, pacing/budget, the cross-turn pass) has no such dependency and can be built independently of Grader's remaining sessions.
