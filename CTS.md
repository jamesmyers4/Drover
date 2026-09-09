# CTS.md — Soak mode build plan

**Provenance:** Originally design notes from a 2026-09-09 planning conversation, sketching a long-running "Continuous Soak-Testing" mode for Drover, first target Shenny. This document was interrogated end-to-end via a `/grill-with-docs` session on 2026-09-09 (`grilling` + `domain-modeling` skills). Every open decision from the original draft's "Open Questions to Resolve Before Building" section is now resolved; the resolutions are recorded as glossary entries in `CONTEXT.md` (see its "Soak mode" subsection) and as ADRs in `docs/adr/0006`–`0010`. **This file is now the session-by-session build plan** — read `CONTEXT.md`'s Glossary (the "Soak mode" subsection) and `docs/adr/0006`–`0010` before starting any session below.

**Original background material** (the purpose statement, the hardware layout, the original architecture sketch) is preserved at the bottom of this file under "Reference material," since it's still the source of truth for *why* — but every ambiguity it originally left open has been resolved above it, in the sections that follow.

---

## How to use this document

Same discipline `FUTUREPLAN.md`/`SESSION-10-PLAN.md` established, because it works:

- **Do not commit at the end of a session.** Leave changes staged/unstaged. The user reviews and commits/pushes by hand, then tells the next fresh session to continue.
- **Do not proceed to the next numbered session in the same sitting**, even if it seems like a natural continuation. Stop, summarize, wait for the go-ahead.
- **Read `CONTEXT.md`'s "Soak mode" Glossary subsection and `docs/adr/0006`–`0010` at the start of the session**, not just this file — the vocabulary and the *why* behind several non-obvious choices live there, not duplicated here.
- Sessions are ordered by dependency. Don't skip ahead — Session 3's scheduler needs Session 1's schema; Session 5 needs Grader's own Sessions 6–8 to have landed first (see below — this is a real external blocker, not just a documentation ordering habit).
- When a session finishes, append a `**Status: done, <date>**` line under its heading the same way `FUTUREPLAN.md`'s Grader sessions do, with enough detail that a fresh session picking up the next one doesn't have to re-derive what was built or why a judgment call went one way. Do not commit — leave that summary in the diff for the user to review alongside the code.

---

## What got resolved (read this once, then trust the ADRs)

A condensed index — full reasoning lives in the linked ADR or `CONTEXT.md` glossary entry, don't re-litigate these:

| Decision | Resolution | Where |
|---|---|---|
| Browser-driven (reuse Actor tier) or direct API calls? | Direct API calls — Shenny's own k6 load tests already prove the pattern (bearer-token auth, 402/429 treated as correct gating) | ADR 0006 |
| Fold into `DomainPack`/`SimConfig`, or a new subsystem? | New subsystem (`src/soak/`), same precedent as Stampede/Grader — `DomainPack`'s goal/checkpoint/persona shape doesn't apply to API-driven pacing/budget traffic | ADR 0007 |
| Blueprint config format (CTS.md's own draft sketched JSON) | TypeScript, default export, `loadDefaultExport` — Drover has never actually had a JSON config format; the non-negotiable constraint is TS everywhere | Glossary: Blueprint |
| Pacing vs. Shenny's real rate limits/usage caps | Feature-aware split: uncapped backbone traffic (Entry creation → ToneEval/EntrySplit) paced by `pacingMs`; the four metered pipelines get their own explicit per-run call budget instead, with headroom under the real caps left to the target's own blueprint to set | Glossary: Backbone traffic |
| No budget ceiling in the original draft | Added `SoakBudget`, a hard-dollar ceiling checked between turns with graceful shutdown — same load-bearing-knob discipline as `SessionBudget`/`analystCeilingUsd`/`graderCeilingUsd` | Glossary: SoakBudget |
| Pacing range | 5–60s randomized for backbone traffic — slow enough to stay a soak test rather than overlap with Stampede's already-existing rapid-fire purpose | This file, Session 3 |
| Where do Shenny-specific "wrong" rules live — Grader, a new module, or the analysis model's judgment each time? | Split: single-turn content judging (guardrail leaks, groundedness) reuses **Grader** via a turn→`Case` adapter; cross-turn patterns (pipeline disagreement, drift, timing anomalies) get a new pass architecturally mirroring the **Analyst tier**'s chunked map-reduce | ADR 0008 |
| Chunking strategy for the end-of-run analysis pass | Mirror the Analyst tier's chunked-Batch-API map-reduce shape for the cross-turn pass; single-turn judging goes through Grader's own existing dispatch, no chunking of its own needed | ADR 0008 |
| Sequencing against Grader (which isn't finished — only Sessions 1–5 exist) | The Grader-Case-adapter session is explicitly gated on Grader Sessions 6–8 landing first (Layer 5 groundedness, layer tie-together, report/CLI); every other Soak session has no such dependency | ADR 0008 |
| Who writes each turn's content — the local driver freely, or a pre-authored bank? | Claude-authored example bank in the blueprint; the local driver only selects and lightly varies it at runtime | ADR 0009 |
| Does `SoakBlueprint` need its own `dataPolicy` guard? | Yes, enforced now (mirrors `assertDataPolicyAllowed`) even though Soak mode is Ollama-only by construction today — closes the gap before a future non-restricted target's blueprint could point a restricted-content run at a hosted driver | This file, Session 2 |
| Where does the real Shenny `GraderPack` live? | In Shenny's own repo/session, not Drover's — same boundary FUTUREPLAN.md already drew for Grader generally | ADR 0010 |
| Where does the real Shenny `SoakBlueprint` live? | Also in Shenny's own repo/session (Shenny has its own planning infrastructure, unlike Horse Haven Ops) — Drover's repo proves the generic engine against its own toy fixture instead | ADR 0010 |
| Results surfacing — report file, CLI summary, or both? | Same `run`/`analyze`/`report` CLI split Discovery mode already uses, plus a new "Soak report" markdown deliverable, reading only the SQLite file | This file, Session 7 |

### Explicitly still open (deferred on purpose — don't silently resolve these mid-build)

- **Turn-digest chunk size default** for the cross-turn pass — will need a number (mirroring `DEFAULT_SESSIONS_PER_CHUNK`'s own flagged-guess precedent in the Analyst tier), not derived from real run data yet. Pick something reasonable in Session 6, flag it as a guess, revisit once real soak runs exist.
- **Real per-pipeline call-budget numbers for Shenny specifically** (how much headroom to leave under `recordingReport: 60/mo`, `messageAnalysis: 150/mo`, `insightReport: 3/mo`, `clarity: 1000/mo`) are Shenny's own blueprint's job, not Drover's — the generic engine only validates that a budget is a non-negative integer, it has no way to know a given target's real caps.
- **Hardware contention between Soak's execution and Grader's own local judges** — both want the same Ollama-hosted GPU box (the i9 desktop, RTX 3070 Ti) at least until a second node is reliably available. Not designed around yet; sequence them (don't run a multi-hour soak execution and a Grader judging pass concurrently on the same box) rather than assume they can share.
- **Toy fixture shape for Session 8** isn't designed yet — needs a small JSON POST endpoint with a simulated per-period cap and an intentional occasional failure, mirroring `examples/toy-app`'s existing "the whole point is to demonstrate Drover actually catching something" precedent. Left to that session to design.
- **Whether Soak's `dataPolicy` guard needs its own approved-provider list** (mirroring the actor tier's `["anthropic", "ollama"]`) or something soak-specific — moot today since Soak's driver is Ollama-only by construction (ADR 0009's consequence: the driver only lightly varies text, never freely generates), but a real answer is needed once a second driver model is ever considered.
- **Real end-to-end validation of the Ollama-driven variation step under a genuinely multi-hour, many-turn run** has never happened — same "unverified against real infra" caveat `GAPS.md` already tracks for `OllamaModelProvider` elsewhere in this project. Flag explicitly in whichever session first gets a real Ollama install to test against; don't fake it.

---

## Cost basis

Unlike Grader (`$0` by design), Soak mode's backbone traffic incurs **real Sonnet costs** once pointed at a real target — every backbone turn fires a real ToneEval + EntrySplit call pair against Shenny. The local driver model itself (Ollama, text-variation only) is `$0`. Cost is bounded by the required `SoakBudget` hard-dollar ceiling, checked between turns with graceful shutdown — in practice this will be the actual governor of how long/far a real run gets, well before `maxDurationHours` or any turn-count limit is reached, mirroring how Discovery mode's budget ceiling already behaves in practice.

**For the sessions below (all Drover-repo work, all against `examples/toy-app`'s fixture, per ADR 0010):** `$0`. No real Anthropic calls, no real Shenny traffic. A session that wants to confirm real Ollama behavior needs a local install available — if none is available in the build environment, use a scripted/mocked provider for the logic/test coverage and flag the real-infra gap explicitly, same precedent `smoke:actor`/Grader Session 4 already established for a missing credential/install.

---

## Soak Session 1 — Storage-layer + core types

**Status: done, 2026-09-09 — not yet committed, review the diff.** `src/soak/migrations.ts` defines `soak.sqlite`'s schema (`soak_runs`, `turns`, `metrics`), applied via the same generic `SqliteStore` runner `DroverDb`/`GraderDb` already use (`src/db/sqlite-store.ts`, ADR 0007's "reuse shared low-level infra opportunistically"). `SoakDb` (`src/soak/db.ts`) mirrors `GraderDb`'s shape exactly — same row-mapping/optional-field-spread style, same `newSoakId()` precedent as `newGraderId()`. Core types in `src/soak/types.ts`, barrel at `src/soak/index.ts`, wired into the top-level `src/index.ts` export (same as Grader Session 1).

One deliberate addition beyond CTS.md's literal `soak_runs` column list: `blueprint_config_json` stores a full snapshot of the resolved `SoakBlueprint` (minus `teardown`, which isn't serializable — `SoakBlueprintConfigSnapshot = Omit<SoakBlueprint, "teardown">`), not just the named `blueprintVersion` tag. Mirrors `Run.config`/`GraderPackConfigSnapshot`'s identical role for the other two subsystems — Session 7's `drover soak report` reads only the DB, so it needs to render the pacing range, pipeline budgets, and variation pool names an already-finished run actually used without re-opening the blueprint file (which may have changed since, or may not be on disk at all in a report-only context). `soak_runs.status` mirrors `RunStatus` verbatim (`running|completed|budget-stopped|crashed`) — Soak has no `sessions`-shaped sub-entity the way Discovery mode does, since a run's own turns absorb explicit errors inline (per ADR 0006/CTS.md Session 3) without ever ending the run early.

`metrics` is intentionally open-ended (`id, runId, name, value, recordedAt`) rather than fixed columns, per CTS.md's own "not an exhaustive list" framing — lets Session 6's timing-anomaly pass (reusing `src/stampede/metrics.ts`'s percentile math) or any future metric get recorded without a schema migration each time.

`VariationPool.lane` (`"backbone" | string`) is the seam between a named example bucket and which of Session 3's two scheduler lanes draws from it — a metered-pipeline pool's `lane` is expected to match a `PipelineBudget.pipeline` for the scheduler to find its budget, a convention documented in both types' doc comments since nothing enforces it structurally at this layer (Session 2's static validation is the natural place to check it, not this session's job to build).

13 new tests in `tests/soak/db.test.ts` (migration, run round-trip/status/spend updates, backbone and metered-pipeline turn round-trips including an explicit error and a non-error 429 gating response, run-scoped/sequence-ordered turn listing, metric round-trip and name-filtered listing). Full project suite (371 tests), `tsc`/`tsc --noEmit`/`biome check`/`npm run build` all clean.

**Cost: $0.** No LLM calls, no CLI yet.

**Goal:** a real, migrated `soak.sqlite` schema and the core TypeScript types, reusing Grader Session 1's generalized `SqliteStore` base rather than forking a third copy of the migration runner.

1. `soak.sqlite` schema (`src/soak/migrations.ts`): `soak_runs` (runId, blueprintVersion, driverModel, target, startedAt, endedAt, budgetCeilingUsd, spentUsd, status), `turns` (turnId, runId, sequence, timestamp, lane (`backbone` | pipeline name), variationId, requestPayload, responsePayload, responseTimeMs, httpStatus, explicitError, errorDetail), `metrics` (open-ended, per CTS.md's own original framing — server response times and load stats are the obvious first columns, not an exhaustive list).
2. Core types (`src/soak/types.ts`): `SoakBlueprint`, `VariationPool` (a named bucket of Claude-authored example narratives plus variation parameters, per ADR 0009), `PipelineBudget` (per-metered-pipeline call ceiling, distinct from the backbone's `pacingMs`, per ADR/Glossary "Backbone traffic"), `SoakBudget` config shape, `TurnRecord`. `SoakBlueprint` carries `dataPolicy: "synthetic-only" | "restricted"` (vocabulary parity with `DomainPack`/`GraderPack`, per this file's resolved decision).
3. `SoakDb` (`src/soak/db.ts`), built on `SqliteStore`, mirroring `GraderDb`'s own shape.
4. Tests: migrations apply cleanly from empty, round-trip a hand-built `TurnRecord` through the schema.

**Stop condition:** schema + types exist, migrate cleanly, tests pass. No scheduler, no CLI, no HTTP dispatch yet. Report what you built and any schema judgment calls made. Do not commit.

---

## Soak Session 2 — Blueprint contract, static validation, CLI skeleton

**Status: done, 2026-09-09 — not yet committed, review the diff.** `src/soak/blueprint-validation.ts` adds `validateSoakBlueprint` — collects every issue in one pass rather than throwing on the first, same precedent `validateGraderPack` set (checks `variationPools` is non-empty and every pool has ≥1 example, every `PipelineBudget.maxCallsPerRun` is a non-negative integer, `budget.ceilingUsd`/`maxDurationHours` are present and positive, `dataPolicy` is one of the two valid values, `targetBaseUrl` parses via `new URL()`, and `driverProvider` is a non-empty string) plus `assertSoakDataPolicyAllowed` (a restricted blueprint's `driverProvider` must be `"ollama"`, checked via an approved-provider `Set` mirroring `assertDataPolicyAllowed`'s own shape — CTS.md's own "explicitly still open" note on whether this needs its own list mechanism is left open long-term, but this is a working, easily-extended answer for now). `drover soak run <blueprint> [--db path]` wired into `src/cli/index.ts` as a `soak` command group (`program.command("soak").command("run")`) — loads + validates, reports valid/invalid, does not dispatch turns yet. `--db` defaults to a single stable `./soak.sqlite`, accepted now for forward compatibility but deliberately not opened or written this session, exactly mirroring Grader Session 2's own `--db` precedent (real persistence lands in Session 3, same as Grader's did in its Session 3).

One schema amendment to already-committed Session 1 work, done as normal iterative evolution rather than history-rewriting: `SoakBlueprint` gained a `driverProvider: string` field (mirrors `ModelRoute.provider`'s loose string typing rather than a locked literal union) — Session 1 didn't need it since nothing consumed it yet, but `assertSoakDataPolicyAllowed` needs a real value to check the driver's provider against. `SoakBlueprintConfigSnapshot` (an `Omit`) and `tests/soak/db.test.ts`'s fixture were updated to match; no `soak_runs` migration was needed since the field rides along inside the already-existing `blueprint_config_json` snapshot column.

Manually verified end-to-end against two throwaway fixture blueprints (not committed, scratchpad-only): a valid one exits 0 with "Blueprint is valid."; one with six deliberately-planted problems (empty pools, a negative pipeline budget, a missing budget ceiling, a zero `maxDurationHours`, a malformed target URL, and a `restricted` blueprint with a non-Ollama driver) exits 1 and reports all six distinguishable issues in one pass. 19 new tests across `tests/soak/blueprint-validation.test.ts` (every validation rule's pass/fail edge cases, the multi-issue collection behavior, and `assertSoakDataPolicyAllowed`'s three cases directly) and one fixture update in `tests/soak/db.test.ts`. Full project suite (390 tests), `tsc`/`tsc --noEmit`/`biome check`/`npm run build` all clean.

**Cost: $0.**

**Goal:** a `SoakBlueprint` can be loaded and validated *before* anything spends real budget or hits a real target — same "fail before spending" discipline Grader Session 2 established for `GraderPack`.

1. `SoakBlueprint` runtime loading — reuse `loadDefaultExport` (`src/orchestrator/config-loader.ts`), same loader every other typed-TS config in this project already uses. No new loader code.
2. **Static blueprint validation** (`src/soak/blueprint-validation.ts`): `variationPool` is non-empty and every bucket has at least one example narrative; every `PipelineBudget` is a non-negative integer; `SoakBudget.ceilingUsd` and `maxDurationHours` are present and positive; `dataPolicy` is one of the two valid values; `targetBaseUrl` is a well-formed URL. Fail loudly with a specific, fix-it message — same precedent `validateGraderPack`/`scripts/preflight-hhops.ts` already set.
3. `assertSoakDataPolicyAllowed` (mirrors `assertDataPolicyAllowed`/`assertHostedGraderDispatchAllowed`): a `restricted` blueprint's configured driver must be Ollama — refuses to proceed otherwise. Checked at validation time here; re-checked at actual dispatch time in Session 4, same defense-in-depth precedent ADR 0002 established for Grader.
4. `drover soak run <blueprint> [--db path]` CLI subcommand (`src/cli/index.ts`) — wires up loading + static validation, reports valid/invalid. Does not yet execute any turns. `--db` defaults to a single stable `soak.sqlite` in the current directory, reused across invocations — **not** a fresh timestamped file per run. This is a deliberate, not accidental, choice: Grader Session 3 hit this exact mistake first (a fresh-file-per-invocation default silently breaks cross-run comparison, confirmed for real against Drover's own `runs/hhops-drover-container-1/2/3.sqlite` fragmentation) and this file exists specifically so that lesson doesn't have to be relearned.
5. Tests: a valid blueprint passes; a blueprint with an empty variation bucket, a negative pipeline budget, a missing budget ceiling, and a `restricted` blueprint configured with a non-Ollama driver each fail with a distinguishable message.

**Stop condition:** `drover soak run <blueprint>` validates and exits cleanly (or fails loudly) — no turns dispatched yet. Report what you built. Do not commit.

---

## Soak Session 3 — Execution loop core: cap-aware scheduler, budget, HTTP dispatch

**Status: done, 2026-09-09 — not yet committed, review the diff.** `src/soak/budget.ts` adds `SoakBudget`/`SoakBudgetExceededError`, structurally identical to `GraderBudget`'s own shape (a running total, `assertCanDispatch()` throws once spend has already reached the ceiling — checked between turns, never mid-turn). `src/soak/scheduler.ts` adds the two-lane dispatch loop and `runSoak`, the entry point: **backbone** draws from `lane: "backbone"` pools paced by a randomized delay within `pacingMsRange`; **metered-pipeline** (one lane per `PipelineBudget`) draws from pools matching that pipeline's name, paced by spreading `maxCallsPerRun` evenly across `maxDurationHours` instead. Both lanes run concurrently via `Promise.all` but dispatch one turn at a time internally, so there's never an in-flight turn to cancel when the budget ceiling crosses — only a "don't start the next one" decision (`SoakBudget.assertCanDispatch()`, caught per-lane to request a shared graceful stop rather than propagate). `runSoak` validates the blueprint first (never inserts a `soak_runs` row for an invalid one, same precedent `runGradingRun` established), runs `teardown` finally-style before the final status/spend write (mirroring `runDiscovery`'s own ordering exactly, including catching and logging — not propagating — a teardown failure), and only throws for a genuine orchestration-level fault (e.g. a DB write failure) — a turn-level HTTP error is always captured on the turn itself, never propagated. `drover soak run` is now wired for real (closing Session 2's own "not yet opened or written" breadcrumb, same as Grader Session 3 did for `drover grade`'s `--db` flag) — it opens `soak.sqlite`, executes the run, and prints real counts. The bearer token is read from `SOAK_AUTH_TOKEN` at the CLI boundary and threaded through as a `runSoak` option, never placed on the blueprint (which gets persisted into `soak_runs.blueprint_config_json`).

Three schema/validation amendments beyond CTS.md's literal Session 3 task list, each because the mechanics genuinely needed them once actually built:
- `VariationPool` gained `path`/`method?` — the scheduler needs somewhere concrete to POST a turn; HTTP dispatch always sends a fixed `{ text: <selected example> }` JSON envelope (a deliberate fixed v1 wire shape, not a pluggable request-builder — flagged in the type's doc comment as something to revisit if a real target's own blueprint, per ADR 0010, needs a different body shape).
- `SoakBudgetConfig` gained `costPerCallUsd?` — CTS.md's own Session 3 spec explicitly calls for "real response cost where the target reports it, or a configured per-call cost estimate." Implemented via a `x-soak-cost-usd` response header convention (`SOAK_COST_HEADER`) a real cost-reporting target may set; falls back to `costPerCallUsd` (or $0) when absent — a toy/non-billed fixture target has no other way to exercise the budget ceiling at all.
- `blueprint-validation.ts` gained three checks the scheduler's own correctness now depends on structurally: every pool's `path` is a non-empty string (`invalid-pool-path`), `pacingMsRange` is well-formed with `minMs <= maxMs` (`invalid-pacing-range`), and every `pipelineBudgets[*].pipeline` matches a declared `variationPools` lane (`unmatched-pipeline-lane` — catches a silent dead lane that would otherwise just never dispatch, with no error at all). The two prior sessions' test fixtures were updated to add a matching `messageAnalysis`-lane pool alongside their existing `pipelineBudgets` entry, which the new cross-check now correctly flags as previously unvalidated.

Manually verified end-to-end against a real (not scripted) local HTTP fixture server and a throwaway blueprint via the actual `drover soak run` CLI subprocess: 7 turns dispatched, 0 explicit errors, status `completed`, real rows written to a real `soak.sqlite` file — confirms the whole path (CLI → `loadDefaultExport` → validation → `runSoak` → real `fetch` → `SoakDb`) works outside the test suite's injected fakes, not just against them. 12 new tests (390 → 402): `tests/soak/scheduler.test.ts` (8 — full backbone-only run with pacing-range assertions, budget-ceiling graceful stop, a forced explicit error not killing the run, the 402/429 gating distinction, real-cost-header vs. configured-estimate precedence, the metered-pipeline lane's cap/pacing math, teardown's exact call contract, and the bearer-token/secrets-discipline check) using a small real local fixture server (`tests/soak/fixture-target.ts`, mirrors `tests/fixtures/site.ts`'s own dynamic-port `node:http` style) plus a fake clock that advances by exactly each requested `sleep` duration instead of actually waiting — deterministic, instant tests that still exercise real duration/pacing arithmetic; and 4 new validation tests in `tests/soak/blueprint-validation.test.ts` for the three new checks above (`invalid-pacing-range` gets two: inverted and negative). Full project suite (402 tests), `tsc`/`tsc --noEmit`/`biome check`/`npm run build` all clean.

**Cost: $0** (toy fixture only, no local-model variation wired in yet — turns dispatch the example bank's text verbatim, proving the scheduler/budget/dispatch mechanics in isolation first, same "prove the mechanism before adding model infra" precedent Grader Session 3 set with Layer 1).

**Goal:** a full soak run executes end-to-end against a toy target, respecting pacing, per-pipeline budgets, and the hard-dollar ceiling.

1. `scheduler.ts` — two lanes: **backbone** (draws from the backbone variation pool, paced by randomized `pacingMs` within the blueprint's configured range) and **metered-pipeline** (draws from each pipeline's own pool, paced by spreading its `PipelineBudget.maxCallsPerRun` across `maxDurationHours` rather than `pacingMs`). A `402`/`429` response is logged as an expected gating outcome, not an error — same distinction Shenny's own k6 scripts already draw.
2. `SoakBudget` — running `spentUsd` tracked from real response cost where the target reports it (or a configured per-call cost estimate for a toy/non-billed target); `assertCanDispatch()` throws before a turn that would exceed `ceilingUsd`, causing a graceful stop (drain in-flight work, write final `soak_runs` row, never die mid-write) — mirrors `SessionBudget`'s own "checked between, not mid-, unit of work" contract.
3. HTTP dispatch: plain `fetch` against `blueprint.targetBaseUrl`, bearer token from an env var (never logged, never sent to the driver model — secrets stay in the HTTP layer only, per the project-wide non-negotiable constraint). Explicit errors (non-2xx the blueprint doesn't mark as expected-gating, thrown exceptions, timeouts) are caught inline and logged to `turns`, never allowed to kill the run — an explicit error is itself a result worth having, per CTS.md's own original framing.
4. Optional `SoakBlueprint.teardown` hook, called once at run end — same timestamp-window-sweep contract `DomainPack.teardown` already established (the non-negotiable "staging teardown wipes everything a run created" constraint applies here identically).
5. Tests: a toy blueprint with only backbone traffic runs a full soak run against a local fixture — turns recorded, pacing respected (within a tolerance), budget ceiling stops the run gracefully when crossed, a forced explicit error is captured without killing the run.

**Stop condition:** a full soak run executes end-to-end against a toy fixture, writes real rows to `soak.sqlite`, respects both pacing lanes and the budget ceiling. Report what you built, including any scheduler edge cases hit. Do not commit.

---

## Soak Session 4 — Local-model text variation

**Status: done, 2026-09-09 — not yet committed, review the diff.** `src/soak/content-provider.ts` adds `SoakContentProvider` (a `vary()` interface, distinct from the actor tier's `decide()`/Grader's `score()` — a different tool schema entirely) with two implementations: `OllamaSoakContentProvider` (real, reuses `OllamaModelProvider`'s exact HTTP-calling pattern against a new `vary_narrative` OpenAI-style tool) and `ScriptedSoakContentProvider` (test double, same script-array-with-exhaustion-error precedent as `ScriptedModelProvider`/`ScriptedGraderProvider`). `src/soak/content-prompt.ts` builds the system/user prompt, split out for the same reason the actor tier and Grader both split their own `prompt.ts` from `provider.ts`. `createSoakContentProvider` is a switch-default-throw factory mirroring `createModelProvider` exactly — only `"ollama"` is implemented (ADR 0009), an unsupported `driverProvider` throws rather than silently guessing. `scheduler.ts`'s `dispatchTurn` now runs select→vary→dispatch→log per turn: every example is lightly varied via `ctx.contentProvider.vary()` before the HTTP request is built, and `runSoak` defaults `contentProvider` to `createSoakContentProvider(blueprint)` when the caller doesn't inject one (real Ollama in production, `ScriptedSoakContentProvider` in tests).

There is deliberately **no Anthropic implementation** of `SoakContentProvider` — unlike the actor tier and Grader, which both have a hosted option, ADR 0009 makes Soak's driver Ollama-only by construction. This also means a provider-level `dataPolicy` self-guard (the way `AnthropicGraderProvider` carries one) would be a tautology here, since `"ollama"` is always permitted regardless of `dataPolicy`. The real defense-in-depth re-check (CTS.md's own Session 4 item 2, mirroring ADR 0002's "one chokepoint isn't trusted alone") instead lives at the actual dispatch site: `dispatchTurn` calls `assertSoakDataPolicyAllowed(blueprint.dataPolicy, ctx.contentProvider.provider)` immediately before every `vary()` call, checking the *constructed provider's own identity* rather than re-reading the same static `blueprint.driverProvider` field Session 2's validation already checked once — a meaningfully different check that would catch a future `createSoakContentProvider` bug or a caller injecting a mismatched provider directly, not just re-run the identical comparison on the identical data. This guard's own violation is never caught by the surrounding per-turn error handling — it propagates uncaught and crashes the run, mirroring Grader's explicit precedent that a guard violation is a structural misconfiguration, not a transient provider failure, and must not be softened into the same bucket as one.

A `vary()` call that fails (a malformed response, a real Ollama install being unreachable, anything) is recorded as its own explicit-error turn — `errorDetail: "variation failed: ..."`, no HTTP request is even attempted — rather than falling back to verbatim text or crashing the run. This extends CTS.md's own "an explicit error is itself a real result worth having" framing from the HTTP layer (Session 3) one step earlier, to the variation layer.

**No local Ollama install was available in this build environment** (`curl` to `localhost:11434` timed out, confirmed both before and after building this session's code) — same gap already flagged for Grader Sessions 4/5, not faked. All logic/dispatch tests use `ScriptedSoakContentProvider` or a mocked `fetch` (same `vi.stubGlobal("fetch", ...)` precedent `tests/actor/provider.test.ts`/`tests/grader/provider.test.ts` already established) for `OllamaSoakContentProvider`'s own request/response handling — no real end-to-end confirmation against a live local driver happened. What *did* happen for real, end-to-end, via the actual `drover soak run` CLI subprocess against a real local fixture HTTP server: with the default (real) `OllamaSoakContentProvider` and no Ollama reachable, a full run completed gracefully with all 4 turns recorded as explicit variation-failure errors and zero requests ever reaching the target fixture server — direct, real confirmation that the "never allowed to kill the run" contract holds even when the entire driver layer is unavailable, not just a hypothetical the test suite asserts in isolation.

19 new tests (402 → 421): `tests/soak/content-provider.test.ts` (16 — prompt-building constraints, `ScriptedSoakContentProvider`'s replay/exhaustion, and `OllamaSoakContentProvider`'s full request/response handling via mocked `fetch`: default base URL and POST target, a well-formed parse, a missing-tool-call `MalformedVariationError`, a missing-`variedText` `MalformedVariationError`, a non-OK HTTP status, a baseUrl override, and the factory's ollama/unsupported-provider branches) plus 3 new tests in `tests/soak/scheduler.test.ts` (the literal "dispatches locally-varied, not verbatim, text" stop-condition proof; a variation failure recorded as an explicit turn error with zero HTTP calls made; and the dispatch-site `dataPolicy` defense-in-depth re-check catching a deliberately mismatched injected provider). Session 3's own 8 scheduler tests were updated to inject an `echoProvider` helper (a `ScriptedSoakContentProvider` that returns each test's original example text unchanged) now that every turn is mandatorily routed through a content provider — their assertions were otherwise untouched, since an echoed marker string still triggers the fixture's forced-error/gating logic identically. Full project suite (421 tests), `tsc`/`tsc --noEmit`/`biome check`/`npm run build` all clean.

**Cost: $0 if a local Ollama install is available; flag explicitly (don't fake it) if not.**

**Goal:** wire the actual local driver model into the loop — the last piece standing between Session 3's mechanics and CTS.md's original "a local LLM drives a blueprint continuously" framing.

1. A soak-scoped provider (reuse `OllamaModelProvider`'s HTTP-calling pattern from `src/actor/provider.ts`, new tool schema — "lightly vary this example narrative given these parameters," not `decide_action`). Cost always `$0`, per the existing Ollama precedent.
2. Wire `assertSoakDataPolicyAllowed` at actual dispatch time (Session 2 built the validation-time check; this is the defense-in-depth re-check immediately before a variation call, mirroring ADR 0002's "one chokepoint isn't trusted alone" for Grader).
3. `ScriptedSoakContentProvider` test double, same script-array precedent as `ScriptedModelProvider`/`ScriptedGraderProvider`.
4. Tests: the scripted provider exercises the full select→vary→dispatch→log path with no real model. If Ollama is available, one real end-to-end confirmation against it — explicitly report whether this happened or was skipped.

**Stop condition:** a soak run's backbone turns carry real (or scripted, if no Ollama) locally-varied text, not verbatim example-bank copies. Report what you built, and explicitly flag whether real-Ollama validation happened. Do not commit.

---

## Soak Session 5 — Turn → `Case` adapter (Grader integration)

**BLOCKED until Grader Sessions 6–8 land** (Layer 5 groundedness, the full layer tie-together via `runGrading`, and Grader's report/CLI don't exist yet as of this writing — see ADR 0008). Check `FUTUREPLAN.md` for Grader's current session status before starting this one. If Grader Session 8 hasn't landed, stop here and pick a different open item instead of building against an interface that doesn't exist yet.

**Cost: $0.** No LLM calls of its own — this session is a data-shape adapter, not a judging pass.

**Goal:** a generic, target-agnostic function that turns a `turns` row into a Grader `Case`, so any target's soak turns can be fed into Grader without Drover needing to know that target's actual rubric content.

1. `src/soak/grader-adapter.ts` — `turnToCase(turn, rubricKeyFor: (turn: TurnRecord) => string): Case`. The `rubricKeyFor` mapping function is supplied by the caller (i.e., by the target's own blueprint/pack, not hardcoded here) — this is the seam that keeps Shenny-specific rubric knowledge out of Drover's repo, per ADR 0010.
2. `input`/`output` mapping: `input` carries the turn's `requestPayload` plus whatever context a groundedness check needs (e.g. the source records an output is supposed to be grounded in) — the exact shape of "enough context" is target-specific and left to the caller to assemble; this session only defines the adapter's contract, not what any particular target passes through it.
3. Tests: a hand-built `TurnRecord` round-trips through `turnToCase` into a valid `Case` shape Grader's own schema accepts (verified against Grader's real types, not a duplicated shadow schema).

**Stop condition:** the adapter function exists, is tested against Grader's real `Case` type, and is target-agnostic (no Shenny-specific code anywhere in this session). Report what you built. Do not commit.

---

## Soak Session 6 — Cross-turn pattern mining (Analyst-shaped pass)

**Cost: $0 for the toy-fixture tests in this session; real cost only once pointed at real turn data from a real target, same as the Analyst tier's own Batch API cost.**

**Goal:** the pass Grader structurally can't do — patterns across turns, not within one.

1. Turn-digest chunking (`src/soak/digest.ts`) — mirrors `buildSessionDigest`'s shape (derived metrics from raw turn data, capped trace) but for turns, chunked at a configurable size (pick a default, flag it as a guess, same as `DEFAULT_SESSIONS_PER_CHUNK`).
2. Cross-turn prompt + provider call (`src/soak/cross-turn-prompt.ts`, reusing the Analyst tier's Batch API provider shape) — looks for: two turns disagreeing about the same underlying record, drift across near-identical turns, recurring explicit-error clusters worth grouping/root-causing.
3. Timing-anomaly detection reuses `src/stampede/metrics.ts`'s percentile math directly (p50/p95/p99 per lane/pipeline) — no new statistics code.
4. Aggregation across chunks into cross-turn findings, one `Promise.all` pass per chunk, same concurrency shape the Analyst tier's `drover analyze` already uses. Cross-chunk correlation gap (a pattern spanning two different chunks) is accepted, same known trade-off the Analyst tier already carries and documents.
5. Tests: a fixture set of turns with a deliberately planted cross-turn pattern (e.g. two turns with contradictory outputs about the same synthetic record) gets detected via a scripted analyst-style provider.

**Stop condition:** a cross-turn pass runs against a fixture turn set and surfaces a planted pattern. Report what you built and the chunk-size default chosen. Do not commit.

---

## Soak Session 7 — `drover soak analyze` + `drover soak report`

**Depends on Session 5 (blocked on Grader) and Session 6.** If Session 5 is still blocked when this is picked up, build the Session-6-only half (cross-turn findings) and explicitly note that Grader-sourced single-turn findings are pending until Session 5 unblocks — don't silently ship a report that looks complete but is missing a whole category of findings without saying so.

**Cost: depends on real turn volume — use a small toy run, not a large one, for this session's own testing.**

**Goal:** tie both analysis passes together behind one CLI command, and produce the human-facing deliverable.

1. `drover soak analyze <run-id> --db <path>` — runs Session 5's Grader-Case pass (if available) and Session 6's cross-turn pass, persists both sets of findings.
2. `drover soak report <run-id> --db <path> [--out path]` — a new **Soak report** (markdown), reading only `soak.sqlite`: turn volume by lane, explicit-error clusters, Grader-graded findings (once Session 5 exists), cross-turn findings, cost actuals vs. `SoakBudget`. Same "no re-simulation, no re-analysis, reads only the DB" rule `buildRunReport` already follows.
3. Tests: golden-file-style report snapshot test, same precedent `tests/report/markdown.test.ts` already uses.

**Stop condition:** `drover soak analyze` and `drover soak report` both run end-to-end against a toy run, report reviewed. Report what you built, share the sample report. Do not commit.

---

## Soak Session 8 — Toy fixture + end-to-end validation

**Cost: $0**, mirroring Grader Session 8's own toy-pack validation.

**Goal:** prove the whole engine works end-to-end against a throwaway example blueprint — mirroring `examples/toy-app`'s role for the simulation stack and Grader Session 8's role for Grader — *before* Shenny's own session builds a real one.

1. A small JSON API fixture, extending `examples/toy-app` (or a sibling fixture, if the toy-app's static-HTML shape doesn't fit) — needs at least one POST endpoint that accepts a varying payload, a simulated per-period cap (so the metered-pipeline lane's budgeting logic has something real to respect), and an intentional occasional failure (same "the whole point is to demonstrate Drover actually catching something" precedent the original toy-app already set with its `/api/horses/more` 500).
2. A toy `SoakBlueprint` (`examples/`) — a handful of variation buckets, a small `SoakBudget` ceiling, pointed at the new fixture.
3. A real, small-scale validation run: execution (Sessions 1–4) → both analysis passes (Sessions 5–6, Grader half included if unblocked by then) → report (Session 7), start small, confirm it works, don't run a large batch speculatively — same staged-budget approach `SESSION-10-PLAN.md` used for the actor tier.
4. Compile a plain-language summary of what the reference run actually demonstrated (which lanes ran, whether the simulated cap triggered correctly, whether the planted cross-turn pattern was caught, what the report looked like) — the artifact that makes it credible to say "the engine works" before Shenny is asked to build against it.

**Stop condition:** a real Soak run completes end-to-end against the reference fixture and blueprint, report reviewed. This is the natural handoff point to Shenny's own repo/session. Report results plainly. Do not commit.

---

## Notes for whoever picks up the Shenny-side session

Soak mode lives entirely in Drover — Shenny's repo/session supplies exactly two things: a real `SoakBlueprint` and (separately, per Grader's own established boundary) a `GraderPack`. Read this before writing either.

- **Don't build soak-engine internals in Shenny's repo.** If something feels like it belongs in the scheduler/budget/dispatch machinery rather than the blueprint's content, it probably belongs as a Drover session, not a Shenny one — same rule FUTUREPLAN.md already states for Grader.
- **Shenny's `SoakBlueprint.dataPolicy` is `restricted`.** Under Soak's resolved `dataPolicy` semantics (mirroring ADR 0002's Grader precedent), the driver must be Ollama — no hosted-model exception. Don't port over the actor tier's `restricted`-but-Anthropic's-fine bundling; Soak's guard doesn't have one.
- **Budget the four metered pipelines with real headroom, not the whole cap.** `TIER_CAPS.PREMIUM` (via the existing staging-only `SELF_UPGRADE_ENABLED` bypass, already gated by `SELF_UPGRADE_ALLOWED_EMAILS`) gives `recordingReport: 60/mo`, `messageAnalysis: 150/mo`, `insightReport: 3/mo`, `clarity: 1000/mo` — a soak run's `PipelineBudget.maxCallsPerRun` per pipeline needs to leave room for whatever else that same test account does in the same billing period (including repeated soak runs), not consume the entire monthly cap in one run. `insightReport`'s real trigger is a 90-day rolling threshold/velocity trigger, not something meant to be called repeatedly at all — consider whether Soak mode should call it directly more than a handful of times per run, if ever, versus just observing it fire naturally.
- **Respect the burst rate limits too**, not just the monthly caps — `src/lib/ratelimit.ts`'s starting windows (`messageAnalysis 5/60s`, `clarity 10/60s`, `recordingReport 10/60s`, `insightReport 3/60s`) apply on top of the monthly cap and will 429 a burst that's well within budget but too fast.
- **Use the TEST_AUTH_TOKEN pattern Shenny's own k6 scripts already use** (`tests/load/scenarios/auth-helper.ts` — a bearer token from an env var) rather than inventing a second auth mechanism for the same staging environment.
- **Variation-pool content needs review before a multi-hour unattended run**, per ADR 0009 — Claude authors the example bank in the blueprint file itself; the local driver only lightly varies it. Don't hand the driver open-ended authorship of synthetic domestic-conflict narratives.
- **`Case.rubric` is a name, not an inline object**, and rubrics are keyed per AI pipeline — ToneEval, EntrySplit, RecordingReport, InsightReport, Clarity, and ContextSnapshot likely each need their own named rubric in `GraderPack.rubrics`, reusing Soak Session 5's generic `turnToCase` adapter with a Shenny-specific `rubricKeyFor` mapping (by which endpoint/pipeline a turn hit).
- **Shenny-specific "wrong" rules become rubric Checks, not new engine code**: a no-diagnosis guardrail leak, InsightReport/ContextSnapshot output drifting from its own underlying entries (Layer 5 groundedness — needs the source entries passed through as part of `input`), unwarranted certainty about motivation/intent. "Two pipelines disagreeing about the same entry" is *not* a rubric Check — it's cross-Case, so it belongs in the cross-turn pass (Soak Session 6), not the `GraderPack`.
- **Use the shared vocabulary.** `CONTEXT.md`'s "Soak mode" Glossary subsection (Soak mode, Blueprint, Turn, Backbone traffic, SoakBudget, Turn digest/cross-turn pass) is canonical — Shenny's own context doc should use these terms rather than inventing parallel ones. If Shenny's session needs a term this vocabulary doesn't cover, that's a real domain-modeling gap worth raising back here, not silently working around.
- **Hardware:** the i9 desktop (RTX 3070 Ti) is the intended host for a real overnight run, per the original hardware notes below. It's also where Grader's own local judges run — don't schedule a multi-hour soak execution and a Grader judging pass concurrently on the same box until a second GPU node is reliably available for one of them.

---

## Reference material (original planning content, background only — see resolutions above for anything this leaves ambiguous)

### Purpose (original framing)

Extend Drover with a long-running mode: a cheap local LLM drives a Claude-authored test blueprint continuously against a target app (first target: Shenny) for hours at a time, logs every turn to a temporary database, and hands the finished run off to a stronger model for analysis. Goal is to surface the failures that don't show up in a short bounded test — the edge case that only appears on the 4,000th weird-but-plausible interaction, or a "silent" error that never throws an exception but is still wrong (bad data in an AI pipeline's output, a guardrail quietly leaking, drift between related outputs).

This isn't a new tool. It's the same three pieces Drover already has — scenario assembly, execution, and the Grader — pointed at a target continuously instead of for one bounded session, with a local model as the driver instead of Claude.

It also mirrors the existing hybrid dev workflow: Claude designs the plan, a local model grinds through execution, Claude reviews the results. Same shape, pointed at testing instead of coding.

### Defining "wrong" for Shenny specifically (original list, now routed per ADR 0008 — see "Notes for whoever picks up the Shenny-side session" above for where each one actually lives)

General, target-agnostic: uncaught exceptions, non-2xx responses, timeouts, response shape/schema mismatches.

Shenny-specific: a no-diagnosis guardrail leak (naming a personality disorder instead of staying at pattern-level description); InsightReport or ContextSnapshot output drifting from what the underlying logged entries actually support; two pipelines disagreeing about the same entry in a way that doesn't make sense; output asserting someone's motivation or intent with unwarranted confidence rather than describing an observed pattern.

This list should live as versioned rules, not a one-time hardcoded set — expect to keep adding to it as real runs surface new categories.

### Hardware / runtime notes

Desktop is the right first host: nothing else needs the GPU overnight, and it clears the laptop's (qwen2.5:3b) throughput by a wide margin. Not a long-term answer if this earns a longer leash later — permanently parking a multi-day run on the desktop GPU competes with actually using the machine. The headless Acer Aspire (already an always-on box running as a GitHub Actions runner) is the natural next step, but it has no GPU, so CPU-only throughput on whatever model it ends up running would need checking before treating it as the target host. Not a now problem. Driver model: llama3.1:8b via Ollama, i9 desktop, 32GB RAM, RTX 3070 Ti.

### Later / out of scope for this pass

**Purple-team integration.** Run adversarial/security probing scenarios concurrently against the same live test environment while normal simulated usage runs — extending this same continuous-run infrastructure to double as an automated security exercise, tying back into the ethical-hacking practice work. Noted as a future direction, not part of this build.
