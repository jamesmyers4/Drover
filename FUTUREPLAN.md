# FUTUREPLAN.md — Grader build plan

**Provenance:** Originally the Drover-focused half of a broader planning conversation that also covered Shenny (adversarial/security testing — out of scope here, lives in Shenny's own repo/context doc). This document was interrogated end-to-end via a `/grill-with-docs` session on 2026-07-30/31 (`grilling` + `domain-modeling` skills). Every open decision from the original doc's §5 is now resolved; the resolutions are recorded as glossary entries in `CONTEXT.md` and as ADRs in `docs/adr/`. **This file is now the session-by-session build plan** — read `CONTEXT.md`'s Glossary section (the terms below assume it) and `docs/adr/0001`–`0005` before starting any session below.

**Original background material** (the layered testing model, the fresh-context architecture rationale, the hardware layout) is preserved at the bottom of this file under "Reference material," since it's still the source of truth for *why* — but every ambiguity it originally left open has been resolved above it, in the sections that follow.

---

## How to use this document

Same discipline `SESSION-10-PLAN.md` established, because it works:

- **Do not commit at the end of a session.** Leave changes staged/unstaged. The user reviews and commits/pushes by hand, then tells the next fresh session to continue.
- **Do not proceed to the next numbered session in the same sitting**, even if it seems like a natural continuation. Stop, summarize, wait for the go-ahead.
- **Read `CONTEXT.md`'s Glossary and `docs/adr/0001`–`0005` at the start of the session**, not just this file — the vocabulary and the *why* behind several non-obvious choices live there, not duplicated here.
- Sessions are ordered by dependency. Don't skip ahead — Session 3's scheduler needs Session 1's schema; Session 5's consensus logic needs Session 4's provider.

---

## What got resolved (read this once, then trust the ADRs)

A condensed index — full reasoning lives in the linked ADR or `CONTEXT.md` glossary entry, don't re-litigate these:

| Decision | Resolution | Where |
|---|---|---|
| Is this a 4th tier? | No — a separate subsystem, own module/tables/CLI, opportunistically reuses shared infra | ADR 0001, Glossary: Grader |
| "No quorum" non-goal conflict | Narrowed to Fixer-tier autonomous-action approval; Grader consensus is a distinct, allowed mechanism | ADR 0001 |
| Name | **Grader** (not "Judge" — collides with "LLM-as-judge," the technique name) | Glossary: Grader |
| Does Grader trigger generation? | No — pure function over `{input, output, rubric}` triples, adapter's job to supply them | Glossary: Grader |
| Task list schema (§2.3's open question) | `Grading Run` → `Case` → `Task` (dispatch unit, not intrinsically LLM) → `Check` (data inside a Task result) → `Consensus Round` (variable-width, per-Check resolution) | Glossary: all five terms |
| Cross-layer gating | Always-run-everything by default (coverage > cost); opt-in prerequisite DAG only for "structurally meaningless without X," gated by a required justification string; `skipped` is a first-class third Task status | Glossary: Task |
| Where does task-list state live? | Its own SQLite file (`grader.sqlite`), own schema, no FK to `runs` — concurrent-writer safety, not just cleanliness | Q6 (this session) |
| Model-family diversity | Structural invariant (`modelFamily` field, checked at dispatch), not inferred from which physical box ran a judge | ADR 0003 |
| Screener's role | An ordinary always-run layer for report triage/sorting only — **never** a dispatch gate (that's the sanctioned prerequisite-DAG path only) | Glossary: Screener |
| Consensus resolution granularity | Per-Check, not holistic — preserves auditability, keeps escalation genuinely rare | Q11 (this session) |
| Escalation Task's inputs | Shared Case context + **both judges' reasoning**, not just their scores — persisted at judge-Task-write-time, not reconstructed later | Q11 (this session) |
| Parallelism (2 GPU boxes) | Sequential-by-default for v1 (mirrors `concurrencyCap`'s precedent), but every Task records `executionTarget` (distinct from `modelFamily`) so the future toggle is config, not a rewrite | ADR 0004 |
| `dataPolicy` for GraderPack | `restricted` = local-only, full stop. `allowHostedEscalation` is a **separate**, fail-closed (`default: false`) flag, checked **per-dispatch** (not once at startup) since escalation happens dynamically mid-run | ADR 0002 |
| CI wiring | Self-hosted runner only (judge-pool reachability, not CLI behavior, is the real blocker); same full run on a schedule, not a fast PR-gating subset; exit code + **versioned** JSON summary, separate from the markdown report | ADR 0005 |
| Reporting | Own markdown `Grading report`, distinct file from the CI JSON summary; renders `skipped` as its own category; triages Cases by escalation count then skip count; embeds rubric content (hash + text), not just a name reference | Q14 (this session) |
| GraderPack shape | `{ appName, rubrics: Record<string, Rubric>, loadCases, layers?, dataPolicy, allowHostedEscalation? }` — no `teardown`/`auth` (never touches the target app) | Q8 (this session) |
| `Case.rubric` | A string key into `GraderPack.rubrics`, resolved at dispatch, **snapshotted (content or hash) onto the Task result** at persistence — so re-grading months later stays interpretable even if the pack's rubric changed | Q8 (this session) |
| v1 layer scope | Layers 1–7 only. Layer 8 (drift monitoring) doesn't fit the Case type signature and needs accumulated run history to even design against — deferred, not dropped. Layer 9 (human sampling) needs zero Grader code — already served by the report's triage ordering | Q15 / `CONTEXT.md` Open questions |
| CLI shape | `drover grade <pack> [--db path]` — a subcommand of the existing CLI, not a second binary | Q7 (this session) |
| Storage-layer code | Generalized (parameterized over file + schema), not forked from `src/db/`'s existing migration runner | Q6 (this session) |

### Explicitly still open (deferred on purpose — don't silently resolve these mid-build)

- **Fail-threshold policy shape** for a CI gate (count-based? percentage? layer-weighted? escalation-rate-as-its-own-signal?) — named as GraderPack config, but *what* that config looks like isn't decided. (ADR 0005)
- **JSON summary schema's exact versioning scheme** — intent to version (`schemaVersion` field) is decided; the scheme isn't. (ADR 0005)
- **Data-at-rest sensitivity of `grader.sqlite`** — encryption, cloud-sync-folder exclusion, `.gitignore` treatment for a `restricted` pack's persisted Case content. (ADR 0002's closing note)
- **Self-hosted-runner network exposure** for a `restricted` pack — a CI runner reachable from the judge-pool boxes is a new exposure surface, flagged not solved. (ADR 0005)
- **Per-Check vs. escalation-rate tracking as an operational metric** — Question 10 flagged that "escalation is rare" is a hoped-for empirical outcome, not a structural guarantee; watch real usage once this is running.
- **Layer 8 design** — blocked on accumulated Grading Run history existing first; when it's picked up, check whether `grader.sqlite`'s schema needs a migration to make "find this Case's prior results" tractable.
- **`grading_runs` has no field distinguishing a manual dev-time run from a CI-triggered scheduled one** (flagged 2026-07-31, once Session 3 made `grader.sqlite` a single shared, accumulating file rather than a fresh file per invocation — see that session's status entry above). Once ADR 0005's CI wiring lands (nightly/on-merge runs) alongside ordinary manual `drover grade` invocations, both kinds of runs land in the same table with no structural way to tell them apart — a problem for Q14's report (if it ever wants to distinguish "the last CI run" from "someone's local scratch run") and for Layer 8's eventual history comparison (if a baseline should only be drawn from one kind of run, not either). Not a problem yet — Session 1's schema was never scoped to answer this, and `pack_config_json` plus timing might turn out to be enough to infer it after the fact anyway. Check this before building either of those two features on the unstated assumption that every row represents the same kind of run.

---

## Cost basis

Unlike the simulation stack, most of Grader's cost is **$0 by design** — local Ollama models on owned hardware, per `allowHostedEscalation: false` being the expected default posture (especially for a `restricted` pack). The only real dollar cost is:

- **Escalation Tasks**, if `allowHostedEscalation: true` is deliberately set and a Consensus Round actually disagrees on a Check (Anthropic API call, small — one Check's worth of context, not a full Case re-judgment, per the scoped-escalation design).
- Sessions that need to *validate against a real Ollama install* carry no dollar cost but do need the install available — same "unverified against real infra" caveat `GAPS.md` already tracks for the actor tier's `OllamaModelProvider`. If no local Ollama is available in the build environment when a session below needs it, use `ScriptedGraderProvider` for the logic/test coverage and flag the real-infra gap explicitly, same graceful-degradation precedent `smoke:actor` already established for a missing `ANTHROPIC_API_KEY`.

No budget-ceiling formula is needed the way `SESSION-10-PLAN.md` needed one for the actor tier — there's no per-session dollar cost to project. `graderCeilingUsd` (Grader Session 5) exists purely to bound the rare escalation path, not routine operation.

---

## Grader Session 1 — Storage-layer generalization + schema foundation

**Status: done, 2026-07-31 — not yet committed, review the diff.** `src/db/sqlite-store.ts` now holds the generic `SqliteStore` (connection + versioned-migration runner), extracted from `DroverDb`'s old constructor/migrate/close logic; `DroverDb extends SqliteStore` unchanged in behavior. `grader.sqlite`'s schema (`src/grader/migrations.ts`) and `GraderDb` (`src/grader/db.ts`) built on the same base. Core types in `src/grader/types.ts`, barrel at `src/grader/index.ts`, wired into the top-level `src/index.ts` export. One post-review refinement: `CheckDefinition` became a discriminated union (`BooleanCheckDefinition | NumericCheckDefinition`) so a numeric Check's tolerance rule is structurally required, not an optional field a pack author could silently omit (closes a real Q11 gap flagged in review); `graderCeilingUsd?: number` added to `GraderPack`/`GraderPackConfigSnapshot` so Session 5's `budget.ts` has a home to read from without a later schema retrofit. 13 tests in `tests/grader/db.test.ts`. Full detail in the session transcript.

**Cost: $0.** No LLM calls, no CLI yet.

**Goal:** a real, migrated `grader.sqlite` schema and the core TypeScript types, with zero forked code from `src/db/`.

1. Generalize `src/db/`'s migration runner and `DroverDb`-equivalent wrapper to be parameterized over *which file* and *which migration set*, rather than hardcoded to the primary db and copy-pasted. This is the third instance of "reuse shared low-level infra opportunistically without becoming part of the tier stack" (after the `ModelProvider` shape and the budget-ceiling pattern) — worth generalizing now while there are only two consumers.
2. Design and implement `grader.sqlite`'s schema: `grading_runs`, `cases`, `tasks`, `consensus_rounds`. Concretely, from this session's resolved decisions:
   - `tasks.status`: `pending | running | pass | fail | skipped` (skipped is first-class, never conflated with fail).
   - `tasks.modelFamily` and `tasks.executionTarget`: separate nullable columns (LLM-backed Tasks only) — do not conflate them (ADR 0003, ADR 0004).
   - `tasks.reasoning`: persisted alongside each Check's score, not the score alone (needed for escalation Tasks to actually adjudicate, per Q11).
   - `tasks.rubricSnapshot` (content and/or hash): resolved at dispatch, persisted at write-time (Q8).
   - `consensus_rounds`: a **real table** storing the resolved outcome (agreed/disagreed/escalated, final verdict) per Check — not a computed grouping recomputed from raw votes on every read.
3. Core types (`src/grader/types.ts`): `GraderPack`, `Case`, `Task`, `Check`, `ConsensusRound`, `Rubric`, `LayerConfig` (a sparse override map keyed by layer id — absent layers run at built-in defaults, per Q8's omission-semantics fix).
4. Tests: migrations apply cleanly from empty, round-trip a hand-built `Task`/`ConsensusRound` row through the schema.

**Stop condition:** schema + types exist, migrate cleanly, tests pass. No scheduler, no CLI, no provider yet. Report what you built and any schema judgment calls made. Do not commit.

---

## Grader Session 2 — GraderPack contract, static validation, CLI skeleton

**Status: done, 2026-07-31 — not yet committed, review the diff.** `validateGraderPack` (`src/grader/pack-validation.ts`) collects every issue in one pass rather than throwing on the first — checks `layers` is a well-formed sparse map (valid 1-7 keys, `enabled`/`requires` shape, every declared prerequisite carries a non-empty justification string), the declared prerequisite DAG has no cycle (DFS, only run once `layers` itself is well-formed, to avoid a redundant cascade error), and every `Case.rubric` (via `pack.loadCases()`) resolves against `GraderPack.rubrics` — plus a `cases-load-failed` issue if `loadCases()` itself throws, so a real failure there is a clean reported issue rather than an unhandled rejection. `drover grade <pack> [--db path]` wired into `src/cli/index.ts` (`--db` accepted for forward compatibility, not yet opened/written). Manually verified end-to-end against throwaway fixture packs: exit 0 + valid-pack summary, exit 1 + multi-issue message on a pack with both a typo'd rubric key and a real prerequisite cycle. Post-review addition: a fourth check (`malformed-rubric`) validates every Rubric's `CheckDefinition`s actually carry the tolerance rule their `scoringType` requires — the Session 1 discriminated union is a compile-time-only guarantee (packs load via `tsx`, untyped at runtime), so a numeric Check missing `numericTolerance` or a boolean Check carrying a stray one is now caught here instead of breaking mid-Grading-Run once `consensus.ts` (Session 5) tries to read it. Also left a breadcrumb in `gradeCommand`'s doc comment for whoever wires `--db` for real in Session 3: validation must keep resolving before any `grading_runs` row is inserted, so a malformed pack never leaves a "crashed" row for a grading run that never actually started. 17 tests in `tests/grader/pack-validation.test.ts`. Full detail in the session transcript.

**Cost: $0.**

**Goal:** a `GraderPack` can be loaded and validated *before* anything spends real work on it.

1. `GraderPack` runtime loading — reuse the existing `loadDefaultExport` pattern (`src/orchestrator/config-loader.ts`) rather than inventing a second loader.
2. **Static GraderPack validation** — its own explicit function, distinct in scope from `validate.ts` (which stays scoped to malformed *runtime LLM output*, per Q13's ownership-gap fix). Checks: every `Case.rubric` key resolves against `GraderPack.rubrics`; `layers` is a well-formed sparse map; any declared prerequisite DAG resolves without a cycle (topological check). Fail loudly with a specific, fix-it message — same "fail before spending budget" precedent `scripts/preflight-hhops.ts` already set for the simulation stack.
3. `drover grade <pack> [--db path]` CLI subcommand (`src/cli/index.ts`) — wires up loading + static validation and reports pack-valid/invalid. Does not yet dispatch any Tasks.
4. Tests: a valid pack passes; a pack with a typo'd rubric key, a malformed `layers` map, and a cyclic prerequisite declaration each fail with a distinguishable message.

**Stop condition:** `drover grade <pack>` runs, validates, and exits cleanly (or fails loudly) — no Tasks dispatched yet. Report what you built. Do not commit.

---

## Grader Session 3 — Scheduler core: DAG-aware dispatch + Layer 1

**Status: done, 2026-07-31 — not yet committed, review the diff.** `src/grader/layer.ts` defines the layer-implementation contract (`LayerRunContext`/`LayerCheckOutcome`/`LayerImplementation`/`LayerRegistry`) in its own file — same "execution-tier seam, not a config schema" precedent as the actor tier's `ModelProvider` living in `provider.ts` rather than `types.ts` — kept separate from `scheduler.ts` specifically to avoid a circular import between the scheduler (which needs `DEFAULT_LAYER_REGISTRY`'s concrete layers) and a layer module (which needs the contract types). `src/grader/layers/layer1.ts` implements Layer 1 (deterministic schema/format checks) as three boolean Checks over `Case.output` — present, JSON-serializable, non-empty (string/array/object emptiness, not just falsiness) — with overall Task status `pass` only if every Check passes; consumes no rubric, per the Case glossary entry. `src/grader/scheduler.ts` is the dispatch loop: `resolveLayerDispatchOrder` topologically sorts the dispatch-candidate layer set (registry-implemented, not explicitly `enabled: false`) via a small Kahn's-algorithm-style pass with ascending-id tiebreaking for determinism, dropping `requires` edges that point outside the candidate set rather than erroring (a prerequisite on an unimplemented/disabled layer is just always unmet, not a graph error); `runGradingRun` is the full entry point — validates the pack first (never inserts a `grading_runs` row for an invalid pack, closing the breadcrumb Session 2 left), then dispatches every eligible layer's Task per Case fully sequentially (ADR 0004), including cascading a skip correctly through a multi-hop dependent chain (a Task's own `skipped` status counts as "not pass" for anything requiring *it*). `drover grade <pack> [--db path]` (`src/cli/index.ts`) now actually dispatches via `runGradingRun` against `DEFAULT_LAYER_REGISTRY` — closing the Session 2 breadcrumb naming this session as "whoever wires `--db` for real."

Two post-review fixes made before closing the session, both caught by review rather than being part of the original implementation:
- **Task-level error isolation, not whole-run crash.** The first pass caught a layer implementation's thrown error at the *run* level, marking the whole `grading_runs` row `crashed` and losing every other Case's results — a direct regression against Q5's coverage-over-cost guarantee (one bad Task shouldn't cost the rest of the batch its results, any more than one failing layer should stop the others). Fixed: `dispatchCaseTasks` now catches a throw per-Task, records it as that Task's own `fail` (a synthetic `task-execution-error` Check carrying the exception message), and the run continues — a downstream dependent still correctly sees it as "not pass" and cascades a skip. `crashed` is now reserved for genuine orchestration-level faults (a DB write itself throwing) — tested via a `GraderDb` subclass that throws from `insertCase`, since a validated pack's `resolveLayerDispatchOrder` can never itself throw (a subset of an acyclic graph can't contain a cycle).
- **`pack.loadCases()` was being called twice per run** — once inside `validateGraderPack` (Session 2), once again inside `runGradingRun` itself. For a stateful adapter (a live DB query, a paginated API call) the two calls could silently disagree on which Cases exist, meaning validation would check a different set than what actually got graded. Fixed: `validateGraderPack` now returns the Cases it loaded (`Promise<CaseInput[]>`, was `Promise<void>`), and `runGradingRun` — and the CLI's `gradeCommand`, which no longer does its own separate pre-validation call either — reuse that single returned list. `pack.loadCases()` now runs exactly once per `drover grade` invocation.

Also fixed, in two passes: `--db` omitted used to mean "validate only, nothing persisted" — a real run could silently leave no audit trail behind if the flag was forgotten, breaking the assumption Q6/Q8/Q14's report/rubric-snapshot machinery all depend on (a report can't be built from a run that wrote nothing). First pass made `--db` always resolve to a real path, but defaulted to a fresh `grader-runs/<timestamp>.sqlite` per invocation, copying `drover run`'s `--out` precedent — which turned out to be the wrong precedent to copy: `--out`'s default names a *report* artifact (correctly wanting a unique path per run), not a database meant to accumulate history the way `grading_runs` needs to for Q14's report and the deferred Layer 8 to ever compare a run against prior ones. Checked whether this was a real risk rather than a hypothetical one: `reconcile.ts`'s "prior runs" query only ever sees rows in the SQLite file that's actually open, and Drover's own `runs/` directory already shows the failure mode for real — `hhops-drover-container-1/2/3.sqlite`, three separate files from three real runs of the same domain pack, meaning cross-run reconciliation between them never actually ran. Second pass: `--db` now defaults to a single, stable `grader.sqlite` in the current directory (Q6's own naming), reused across invocations rather than fragmented into scattered timestamped files, with `--db` reserved for a deliberate override (a scratch run, a CI-specific path). Verified two grade invocations with no `--db` land two `grading_runs` rows in the same shared file. Also checked Q9's data-at-rest tail against this default directly (rather than leaving it as an abstract "worth checking" note): `*.sqlite` is already a repo-wide `.gitignore` pattern with no directory prefix, confirmed via `git check-ignore` to already cover both a bare `grader.sqlite` and any path under a subdirectory — no `.gitignore` change was needed.

No CLI-invocation cycle test was added (matches Session 2's precedent of manual verification for the CLI layer); manually verified end-to-end against a throwaway toy pack — 3 Cases (valid/empty-string/null output) produced 1 pass + 2 fail, both with an explicit `--db` and with the default path. 54 tests across `tests/grader/scheduler.test.ts` (DAG ordering including a genuine out-of-numeric-order dependency, disabled-layer exclusion, cycle-among-candidates defensive throw, skip/cascade behavior, Task-level throw isolation, genuine DB-failure crash) and `tests/grader/layers/layer1.test.ts` (all three checks' pass/fail edge cases, including a circular-reference object and falsy-but-present primitives); `tests/grader/pack-validation.test.ts` updated for `validateGraderPack`'s new return type. Full project suite (285 tests) and `tsc`/`biome` both clean. Full detail in the session transcript.

**Cost: $0.** No model calls — Layer 1 is pure code, which is exactly why it goes first.

**Goal:** prove the scheduler's dispatch/DAG/skip logic end-to-end without needing any model infrastructure to also be working at the same time.

1. `scheduler.ts` — the dispatch loop: reads a Case's accumulated Task results, resolves the prerequisite DAG in topological order, dispatches the next eligible Task. Always-run-everything is the default; a declared prerequisite only skips a layer when genuinely unmet, and only if it carries the required justification string (Q5's guardrail against cost-flavored intuition eroding the coverage default).
2. Sequential dispatch only (ADR 0004) — one Task in flight system-wide. Every Task result still records `executionTarget`, even though nothing consumes it for concurrency yet.
3. Layer 1 (deterministic schema/format checks) implemented as the first real layer.
4. Tests: a toy `GraderPack` with only Layer 1 configured runs a full Grading Run correctly — Cases processed, Tasks recorded with real status values, `skipped` correctly applied when a prerequisite is declared and genuinely unmet.

**Stop condition:** a full Grading Run executes end-to-end against Layer 1 only, writes real rows to `grader.sqlite`. Report what you built, including any DAG-resolution edge cases you hit. Do not commit.

---

## Grader Session 4 — GraderModelProvider + local single-judge layers (2–3)

**Status: done, 2026-07-31 — not yet committed, review the diff.** `src/grader/provider.ts` defines `GraderModelProvider` (`score()`, not `decide()` — a distinct interface from the actor tier's `ModelProvider`, per a structured multi-Check `score_checks` tool call rather than `decide_action`) with three implementations: `OllamaGraderProvider` (local, reuses `OllamaModelProvider`'s HTTP-calling pattern from `src/actor/provider.ts` but with the new tool schema; cost always `$0`), `AnthropicGraderProvider` (hosted, gated by the new `assertHostedGraderDispatchAllowed`), and `ScriptedGraderProvider` (test double, same script-array precedent as `ScriptedModelProvider`/`ScriptedAnalystProvider`). `TokenUsage`/`computeCostUsd` and the truncate-don't-reject reasoning-length discipline (`MAX_REASONING_LENGTH`) are reused directly from `src/actor/`. `src/grader/rubric.ts` adds `resolveRubric` (Case.rubric key → live `Rubric`) and `snapshotRubric` (deterministic SHA-256 content hash + full content, independent of a caller's own object key order) — the first point anything in Grader actually resolves/snapshots a rubric, per Q8. `src/grader/prompt.ts` builds the shared system/user prompt text, parameterized by a `framing` string. Layers 2 and 3 (`src/grader/layers/layer2.ts`, `layer3.ts`) turned out to be mechanically identical — both just resolve the Case's rubric and ask a `GraderModelProvider` to score every Check in one call — so the real dispatch logic lives once in `src/grader/layers/judge-layer.ts`'s `createSingleJudgeLayer(layerId, framing, provider)`, and `layer2.ts`/`layer3.ts` are thin wrappers supplying only their distinct framing text (`GOLDEN_REGRESSION_FRAMING` vs. `LLM_JUDGE_FRAMING`).

Two judgment calls from the first pass were flagged in review as more load-bearing than "log and move on," and were resolved before this session closed — both fixes and the full reasoning live in `GAPS.md`'s 2026-07-31 RESOLVED entries and, for the second, `docs/adr/0002`'s amendment note:

- **A single-judge Task's pass/fail status was driven by boolean Checks only, leaving numeric Checks structurally unable to fail anything.** This was a Session 1 schema gap (no field ever defined what numeric score constitutes a pass), invisible until Session 4 was the first place a real judge Task dispatched. Fixed: `NumericCheckDefinition` gained a required `passThreshold: { comparison: "gte" | "lte"; value: number }`, distinct from `numericTolerance` (Q11's judge-*agreement* rule, not a quality bar) — validated by `validateGraderPack`, applied by `createSingleJudgeLayer`'s status computation, and folded into `snapshotRubric`'s content hash. Two judges agreeing perfectly on a "3/10" score now correctly fails the Check instead of silently passing.
- **The hosted-dispatch gate checked `allowHostedEscalation` unconditionally, ignoring `dataPolicy` entirely.** Not unsafe (strictly more conservative), but not what Question 9 proposed either — the flag was scoped to *restricted* packs specifically, since a `synthetic-only` pack has nothing sensitive to gate. Fixed: `assertHostedGraderDispatchAllowed` now only requires the flag when `dataPolicy === "restricted"`, matching the actor tier's own synthetic-only/restricted asymmetry. Confirmed as a deliberate call, not a wording accident — see the ADR's amendment.

A third question raised in review — whether Layer 2 ("golden dataset regression") is structurally distinct from Layer 3 or just Layer 3 pointed at a differently-labeled rubric — was answered but **not** changed: honestly, it's the latter today. `Case`'s schema (`{input, output, rubric}`) is locked at three fields for v1 and carries no dedicated golden-reference field, so there's no non-LLM structural diff anywhere; a golden-regression pack author can embed a reference example inside `input` itself (adapter-owned, typed `unknown`, already reaches the judge verbatim), but nothing in the engine enforces or signals that shape. Not Session 4's call to relitigate the locked Case schema unilaterally — logged in `GAPS.md` with concrete options for whoever picks it up with a real GraderPack in hand.

`GraderPackConfigSnapshot`/`GraderPack` were **not** extended with a judge-model-routing field (e.g. "which Ollama model/box") — deliberately out of scope here. Session 4's stop condition only needs Layer 2/3's dispatch mechanics proven via an explicit `LayerRegistry` (tests construct `createLayer2(provider)`/`createLayer3(provider)` directly), not a default end-to-end CLI pipeline — that tying-together job belongs to Session 6's `grade.ts`/`runGrading` per its own stated scope ("the entry point tying the scheduler and all seven layers into one coherent Grading Run"). `DEFAULT_LAYER_REGISTRY` (`scheduler.ts`) therefore still only contains Layer 1; Layers 2/3 are dispatched in tests via an explicit registry passed to `runGradingRun`, exactly as the scheduler's `RunGradingRunOptions.layers` override was already designed to support.

**No local Ollama install was available in this build environment** (`curl` to `localhost:11434` refused the connection) — flagged explicitly per this session's own instruction, not faked. All new tests exercise `ScriptedGraderProvider` for dispatch/persistence logic and a mocked `fetch`/`@anthropic-ai/sdk` for `OllamaGraderProvider`/`AnthropicGraderProvider`'s own request/response handling (same mocking precedent `tests/actor/provider.test.ts` already established) — no real end-to-end confirmation against a live local judge happened. 46 new tests across `tests/grader/provider.test.ts`, `tests/grader/rubric.test.ts`, `tests/grader/layers/judge-layer.test.ts`, and `tests/grader/session4-e2e.test.ts` (the last round-trips a full `runGradingRun` — Layers 1–3 — through real `:memory:` SQLite, confirming rubric snapshots, `modelFamily`/`executionTarget`, skip-cascade behavior, and the numeric-only-failure fix all persist correctly), plus updated coverage in `tests/grader/db.test.ts`/`pack-validation.test.ts` for the new `passThreshold` field. Full project suite (331 tests), `tsc`/`tsc --noEmit`/`biome check` all clean on every file this session touched (a pre-existing, unrelated CRLF lint issue on 6 files this session never touched remains on `main`, confirmed via `git stash`). Full detail in the session transcript.

**Cost: $0 if a local Ollama install is available; flag explicitly (don't fake it) if not.**

**Goal:** the first real model-backed layers, and the `dataPolicy` guard in place *before* Session 5 needs it.

1. `provider.ts` — `GraderModelProvider` interface, distinct from the actor tier's `ModelProvider` (different tool schema: a structured multi-Check score+reasoning payload, not `decide_action`). `OllamaGraderProvider` (reuse `OllamaModelProvider`'s HTTP-calling pattern from `src/actor/provider.ts`), `ScriptedGraderProvider` for tests.
2. Rubric-by-reference resolution at dispatch + content-hash snapshot at persistence (Q8) — implemented here, the first point a layer actually consumes a rubric (Layer 1 doesn't).
3. Layer 2 (golden dataset regression) + Layer 3 (single LLM-judge, decomposed into named Checks per the rubric, per §1.2/§2.3) as real Tasks dispatching to a local judge.
4. **`dataPolicy` guard wired now**, even though escalation doesn't exist yet: a `restricted` GraderPack's Anthropic-backed provider refuses to construct/execute unless `allowHostedEscalation` is `true` (ADR 0002). Getting this in place before Session 5 builds the path that actually needs it is deliberate — the guard should exist before there's traffic to guard against, not be bolted on after.
5. Tests: `ScriptedGraderProvider` exercises the full dispatch→score→persist path with no real model. If Ollama is available, one real end-to-end confirmation against it.

**Stop condition:** Layers 2–3 execute against real (or scripted, if no Ollama) judges, results persist correctly including rubric snapshots. Report what you built, and explicitly flag whether real-Ollama validation happened or was skipped. Do not commit.

---

## Grader Session 5 — Consensus Round, per-Check resolution, escalation, budget

**Cost: small, only if escalation actually fires with `allowHostedEscalation: true` on a real test pack.** Test the logic with `ScriptedGraderProvider` (forced disagreement, $0) before any real escalation call.

**Goal:** the full Consensus Round mechanism, per-Check resolution, and every guardrail Q9/Q10/Q11 attached to it.

1. `consensus.ts` — per-Check agreement logic, each Check's own tolerance rule read from the rubric (exact-match for booleans, numeric tolerance for scores — never a Round-wide setting, per Q11). Consensus Round fan-out: 0 to N scoped escalation Tasks (N = Check count), never a fixed width.
2. `scheduler.ts` — `modelFamily` diversity assertion at judge-selection/dispatch time (ADR 0003), independent of `executionTarget`/box placement.
3. Escalation Task dispatch: scoped to the disputed Check(s) only, carries the shared Case context **and both original judges' reasoning**, not just their scores (Q11) — this is what makes the tie-breaker able to actually adjudicate rather than average or coin-flip.
4. `budget.ts` — `graderCeilingUsd`, enforced with a **per-dispatch running-total check before each escalation Task**, not a single pre-flight estimate (mirrors the `dataPolicy` per-dispatch precedent — escalation fan-out is dynamic and only discovered at runtime, so a startup-only check can't catch a mid-run breach).
5. `scheduler.ts` — a **second** `dataPolicy`/`allowHostedEscalation` check immediately before any escalation dispatch, defense-in-depth alongside Session 4's provider-level guard (ADR 0002 was explicit: one chokepoint isn't trusted alone).

**Stop condition:** a Consensus Round with a forced disagreement (via `ScriptedGraderProvider`) escalates correctly, resolves per-Check, and respects both the `dataPolicy` and budget guards. Report what you built and any real-escalation cost incurred, if you ran one. Do not commit.

---

## Grader Session 6 — Remaining layers (4–7) + Grading report

**Cost: depends on test-pack size — use a small toy pack, not a large one.**

**Goal:** the full Layers 1–7 pipeline, tied together, with a real human-facing deliverable.

1. Implement Layers 4–7: pairwise comparison, faithfulness/groundedness, consistency/stability, adversarial/prompt-injection.
2. `grade.ts` — `runGrading`, the entry point tying the scheduler and all seven layers into one coherent Grading Run.
3. **Grading report** (markdown, `src/grader/`'s equivalent of `buildRunReport`/`renderMarkdownReport`) — a file distinct from the CI JSON summary (Session 7), per Q14: renders `skipped` as its own visual category (never absorbed into "not a pass"); ranks Cases by escalation count first, skip count second, as its triage ordering; embeds each Case's resolved rubric (content hash **and** human-readable criteria text inline, not a bare name reference) so the report stays self-contained months later.
4. Tests: golden-file-style report snapshot tests, same precedent `tests/report/markdown.test.ts` already uses for the simulation stack.

**Stop condition:** a full Grading Run across Layers 1–7 produces a real, readable markdown report against a small toy pack. Report what you built, share the sample report. Do not commit.

---

## Grader Session 7 — CI output contract

**Cost: $0.** No new LLM logic, output/documentation work.

**Goal:** everything ADR 0005 decided, actually built.

1. Structured JSON summary output — `schemaVersion` field from day one, preserves per-Check resolution detail (never collapsed to bare pass/fail). This is a durable contract once Shenny's CI builds against it — treat it that way from the first line of code, not just the first line of the ADR.
2. Exit-code contract for CI gating.
3. Documentation (for whoever wires Shenny's CI, not code Drover builds): the self-hosted-runner deployment requirement, and the network-exposure consideration ADR 0005 flagged (a runner reachable from the judge-pool boxes is a new exposure surface for a `restricted` pack).
4. Explicitly document the fail-threshold policy as **open** — GraderPack-configurable, shape not yet decided — rather than silently picking a default that then becomes a de facto standard nobody chose deliberately.

**Stop condition:** `drover grade` emits a real exit code and a versioned JSON summary; documentation exists for the deployment-side requirements. Report what you built. Do not commit.

---

## Grader Session 8 — Reference GraderPack + end-to-end validation

**Cost: small, local-only if Ollama is available.**

**Goal:** prove the whole engine works end-to-end against a throwaway example pack — mirroring `examples/toy-app`'s role for the simulation stack — *before* Shenny's own session builds a real one.

1. A toy/example `GraderPack` (`examples/` directory) — a handful of Cases, a couple of named rubrics, at least one Consensus Round-triggering pair to exercise escalation for real.
2. A real, small-scale validation run against local Ollama if available (staged-budget approach, same spirit as `SESSION-10-PLAN.md`'s Session 4) — start small, confirm it works, don't run a large batch speculatively.
3. Compile a plain-language summary of what the reference run actually demonstrated (which layers ran, whether escalation fired, what the report looked like) — this is the artifact that makes it credible to say "the engine works" before Shenny is asked to build against it.

**Stop condition:** a real (or scripted, if no Ollama, explicitly flagged) Grading Run completes against the reference pack, report reviewed. This is the natural handoff point to Shenny's own repo/session. Report results plainly. Do not commit.

---

## Notes for whoever picks up the Shenny-side session

Shenny has its own context doc and will be worked in its own repo/session — this section exists because Drover's build happens first and establishes the adapter pattern Shenny will consume. Read this before writing Shenny's `GraderPack`.

- **Grader lives entirely in Drover.** Shenny's repo/session supplies exactly one thing: a `GraderPack` — `{ appName, rubrics, loadCases, layers?, dataPolicy, allowHostedEscalation? }`. Do not build any judging-engine internals in Shenny's repo; if something feels like it belongs in the engine rather than the adapter, it probably belongs as a Drover session, not a Shenny one.
- **Shenny's `dataPolicy` is almost certainly `restricted`**, given the adversarial/security-testing content this doc's own provenance note describes. Under this session's resolved `dataPolicy` semantics (ADR 0002), that means **local-only judges, full stop** — `allowHostedEscalation` defaults `false` and should stay `false` unless there's a specific, deliberate, reviewed reason to flip it. It is not a bundled "restricted but Anthropic's fine" exception the way the simulation stack's `DomainPack.dataPolicy` works — don't port that assumption over.
- **Grader never calls Shenny's own AI features.** Per the pure-function boundary (Q3), Shenny's adapter (`loadCases`) is entirely responsible for producing `{input, output, rubric}` triples — via a live call to Shenny's own pipeline, an export, or a fixture. Grader only grades what's hand
ed to it; it will never reach into Shenny's app to generate anything.
- **`Case.rubric` is a name, not an inline object**, and rubrics are keyed **per AI feature**, not per layer. If Shenny has multiple distinct AI pipelines (a hypothetical "ToneEval," "EntrySplit," etc.), each almost certainly needs its own named rubric in `GraderPack.rubrics`, with different Cases in the same batch referencing different keys depending on which feature produced them.
- **Prerequisite declarations need a real justification, not intuition.** If Shenny's pack author is tempted to skip a layer "because it feels pointless after X," that's exactly the failure mode Q5's guardrail exists to block — the bar is "structurally meaningless without X," and the pack schema requires a justification string to make that distinction explicit, not assumed.
- **If Shenny wants CI wiring**, read ADR 0005 in full before assuming standard GitHub Actions works. The real blocker is judge-pool network reachability — Shenny's CI needs a self-hosted runner on the same network as Drover's local judge-pool boxes, which is a real infrastructure decision to make explicitly. v1 has no fast/PR-gating run mode — CI wiring most likely means a scheduled (nightly) full run, not a blocking check on every PR. Consume the versioned JSON summary for automation, not the markdown report.
- **Layer 8 (drift monitoring) isn't available.** If tracking Shenny's AI quality over time is a goal, that's explicitly future work, blocked on Grader having accumulated real run history first — don't try to work around this by inventing a parallel mechanism in Shenny's own repo.
- **Use the shared vocabulary.** `CONTEXT.md`'s Glossary (Grader, GraderPack, Case, Task, Check, Consensus Round, Grading Run, Grading report) is the canonical terminology — Shenny's own context doc should use these terms rather than inventing parallel ones, so the two repos' docs stay legible together. If Shenny's session needs a term this vocabulary doesn't cover, that's a real domain-modeling gap worth raising back here, not silently working around.
- **Structural reference, not content reference:** `packs/horse-haven-ops/domain-pack.ts` is worth a skim for "what a real, non-toy adapter implementation looks like" as a pattern — env-var-sourced config, real routes/checkpoints grounded in the actual target app rather than assumptions — even though `GraderPack`'s actual fields are substantially different from `DomainPack`'s.

---

## Reference material (original planning content, background only — see resolutions above for anything this leaves ambiguous)

### 1. AI Feature Test Coverage — Methods and Techniques

Testing AI-generated output isn't deterministic assertion-checking. Effective coverage layers several kinds of checks, ordered from cheapest/most objective to most expensive/subjective:

1. **Deterministic checks** (always run, cheapest) — schema/format validation, required fields, length bounds, no unexpected PII, valid structured output.
2. **Golden dataset / regression testing** — curated input→expected-output(-properties) pairs, replayed on prompt/model/pipeline changes.
3. **LLM-as-judge (single output)** — one model scores a single response against an explicit rubric, decomposed into specific named criteria scored independently.
4. **LLM-as-judge (pairwise/arena style)** — two outputs compared; judges are more reliable at "which is better" than absolute calibration.
5. **Faithfulness / groundedness checks** — verifying output doesn't state anything unsupported by its input context.
6. **Consistency/stability testing** — same semantic input phrased multiple ways, or repeated runs, checking output doesn't swing wildly.
7. **Adversarial/prompt-injection testing** — content designed to hijack instructions, verifying non-compliance.
8. **Drift/production monitoring** — comparing current outputs against historical baselines. *(Deferred past v1 — see resolutions above.)*
9. **Human-in-the-loop sampling** — stratified review of outputs or judge-flagged borderline cases. *(Needs no Grader code — served by the report's triage ordering.)*

Multi-judge consensus design notes (still true, now implemented per the resolutions above): different model families per judge; randomize pairwise ordering; watch for verbosity bias; decompose rubrics into specific criteria; tier the gating for cost/latency.

### 2. Fresh-Context-Per-Task Architecture

Each unit of AI-driven work runs in a brand-new context window per task; the only persistent state lives outside the model (now: `grader.sqlite`, per the resolutions above). Avoids context degradation and anchoring to earlier mistakes, bounds cost per call, makes each task independently retryable, mirrors stateless-worker patterns (Celery, CI runners) and Claude Code's own subagent mechanism.

This discipline is meant to govern both Grader's own local-model Task execution *and* long Sonnet-driven build cycles like this one — the session-by-session structure above, with its hard stops and fresh-session handoffs, **is** this same pattern applied to how this plan itself gets built.

### 3. Hardware Layout — AI Compute

| Machine | Hardware | Role |
|---|---|---|
| i9 desktop | RTX 3070ti (8GB) | Primary local compute node — coding-flavored model and judge/agent model, run sequentially given VRAM constraints |
| Old PC #1 | RTX 3070 (8GB), added | Secondary node — genuinely independent physical machine, one judge slot in a Consensus Round |

A third machine (Old PC #2) is being converted for a separate, Shenny-scoped purpose (adversarial-testing sandbox) — not part of Grader's scope.

**Model tiering:** a small (3–4B class) screener model for fast triage (report-sorting signal only, per the resolutions above — never a dispatch gate); 7–9B class judge-tier models at 4-bit quantization. Exact model names deliberately not locked in — check current rankings at actual build time.

### 4. Where This Gets Built

Home: Drover, as a separate subsystem (not a tier extension, per the resolutions above). Configurable via the `GraderPack` adapter pattern, mirroring `DomainPack`. Standalone CLI entry point (`drover grade`, a subcommand — per the resolutions above, not a second binary). Split of labor: the generic engine is Drover's work; app-specific rubrics/Cases are each consuming app's own work, in its own repo/sessions.
