# GAPS.md — Drover's own blind spots

Drover shortcomings, missing capabilities, and future-improvement ideas, logged as they surface during builds and real runs (per CONTEXT.md's Learning Loop). Entries here are candidates for post-v1 work — log and move on, don't fix out of scope.

## 2026-07-23 (post-S5, GAPS fix) — `concurrencyCap` above 1 is still not real concurrency, just rejected cleanly

Previously logged as "`concurrencyCap` config field has no effect yet" (silent no-op). `runDiscovery` (`src/orchestrator/run-discovery.ts`) now calls `assertConcurrencyCapSupported` before doing anything else — a `concurrencyCap > 1` throws `ConcurrencyNotImplementedError` instead of being silently ignored (same timing/pattern as `assertDataPolicyAllowed`; covered by a new `run-discovery.test.ts` case). This closes the "silent no-op" half of the original gap. What's still open: there is still no actual bounded-concurrency execution path — a pack author who wants real parallelism has no option, only a clear error telling them it isn't built. Post-v1: implement bounded concurrency (a worker-pool-style scheduler over `buildSchedule`'s output, respecting per-session isolation and the run-level budget ceiling) and only then relax the guard.

## 2026-07-23 (S3) — No local/self-hosted provider for `restricted` domain packs

CONTEXT.md's "Data routing & privacy" names a fully local model (via Ollama) as the zero-exposure actor-tier option for `restricted` domain packs when cost is a concern beyond staying on Anthropic. Session 3 only implements `AnthropicModelProvider`; `assertDataPolicyAllowed`'s approved-provider set for `restricted` packs is just `["anthropic"]` (`src/actor/provider.ts`). Adopters with a real `restricted` app and no Anthropic budget have no provider to route to yet. Post-v1: add an Ollama-backed `ModelProvider` implementation and add `"ollama"` to the approved set once it exists.

## 2026-07-23 (S3) — Cost of a malformed decide_action call isn't recorded against budget

`AnthropicModelProvider.decide()` computes `usage`/`costUsd` only after `parseDecision` succeeds; if the model's tool call is malformed (`MalformedDecisionError`), the API call was still billed by Anthropic but that cost never reaches `SessionBudget` (the promise rejects before returning usage). In practice this is rare (forced `tool_choice` + a small schema), and the amounts are small, but a session that repeatedly gets malformed output could under-report its real spend. Post-v1: have the provider catch the parse failure internally, still compute and report `usage`, and return an error decision rather than throwing past the usage return.

## 2026-07-23 (S3) — Checkpoint detector DSL is intentionally minimal

`src/actor/checkpoint.ts`'s three matchers (`url:`, `selector:`, `text:`) are substring/existence checks only — no regex, no visibility vs. presence distinction, no combining multiple conditions into one checkpoint (AND/OR). Fine for the toy example and Session 3's tests; Session 8's real Horse Haven Ops pack may need one of these and should extend the DSL then rather than working around it with extra checkpoints.

## 2026-07-23 (S3) — Persona trait numeric range isn't specified in CONTEXT.md

CONTEXT.md types `patience`/`techSavviness` as `number` with no documented range. Session 3 assumed 0..1 normalized (`src/actor/prompt.ts` techSavviness bucketing, `src/actor/loop.ts` patience → retry cap and pacing delay). This needs to be codified explicitly in Session 8's domain-pack authoring guide so pack authors don't guess a different scale (e.g. 1-10).

## 2026-07-23 (S5) — No budget enforcement for the analyst tier

The actor tier and the orchestrator both enforce budget ceilings (soft per-session, hard per-run — CLAUDE.md non-negotiable constraint). CLAUDE.md's Session 5 scope doesn't call for an equivalent for the analyst tier, so `runAnalyst` (`src/analyst/analyze.ts`) computes and reports `costUsd` for a run's analysis but never refuses or caps it. In practice this is one Batch API call per `drover analyze` invocation (not per-session, so the blast radius is naturally small), but a domain pack with an enormous number of sessions in one run could still produce an expensive single analyst prompt with no guardrail. Post-v1: consider a per-analysis soft/hard cost cap, or splitting very large runs into multiple batch requests instead of one prompt covering every session.

## 2026-07-23 (S5) — Cross-run reconciliation is two-phase and can be transiently wrong for cross-session findings

`reconcileRunFindings` (Session 4) runs automatically right after a discovery run finishes, but cross-session findings don't exist yet at that point — they're only created later by the separate `drover analyze` command (Session 5, by design: "analyze" is decoupled from "run" so a run can be re-analyzed without re-simulating). That means the orchestrator's own post-run reconciliation pass can misfire for cross-session-typed match_keys: a pattern that's still recurring but hasn't been re-detected yet (because analyze hasn't run) looks absent and gets tagged `resolved`. Fixed by making `recordFindingStatus` an upsert (`src/db/database.ts`, keyed on `(match_key, run_id)`) and having `runAnalyst` call `reconcileRunFindings` again once cross-session findings are written for the run — the second, fuller pass corrects anything the first pass got wrong (covered by `tests/analyst/analyze.test.ts`'s "corrects a premature resolved tag" case). The remaining gap: the `reconciliation` summary `drover run` prints to the console immediately after a run finishes can be transiently inaccurate for cross-session-finding types until `drover analyze` is run for that same run — the on-disk `finding_status_history` table (Session 6's reporting source of truth) is correct only after both commands have run. Post-v1: either have `drover run` optionally invoke `analyze` inline, or make this ordering dependency explicit in Session 6's report output (e.g. flag runs with no analyst pass yet).

## 2026-07-23 — Analyst tier doesn't yet consume the now-populated `ActionEvent.checkpointId`

The actor loop (`src/actor/loop.ts`) now tags an event with the checkpoint it newly satisfied (see CLAUDE.md's Schema & IDs section), so real per-checkpoint reach timestamps exist in `action_events` for the first time. `src/analyst/digest.ts` still uses the older `totalDurationMs`-grouped-by-`goalId` proxy for "checkpoint technically reachable but abnormally slow" — it doesn't take goal/checkpoint context today, so wiring in true per-checkpoint latency means passing the `Goal` (or at least its checkpoints) into `buildSessionDigest` and computing reach-time deltas from the newly-populated `checkpointId` column. Post-v1: do that once a real domain pack's checkpoints make the goalId-duration proxy noticeably imprecise.

## 2026-07-23 (S4) — Domain pack teardown hooks have no record of what a run created

`DomainPack.teardown` (added this session, `src/types/domain-pack.ts` — not in CONTEXT.md's verbatim schema, see BUILD-STATE.md decisions log) is called with only `{ runId, targetBaseUrl }`. It has no list of the actual records/rows a run's personas created (signups, schedule edits, etc.) — CONTEXT.md's "staging teardown wipes everything a run created" assumes the pack author has *some* way to correlate created data back to a run. As built, that correlation is entirely the pack author's responsibility (e.g., tagging synthetic form data with the runId at fill-time, or a timestamp-window sweep) — Drover doesn't track "which app-side records this run touched" anywhere. Worth revisiting once a real domain pack (Session 8's Horse Haven Ops pack) actually needs to implement a non-trivial teardown and finds out whether `runId` alone is enough.
