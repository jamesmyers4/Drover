# CLAUDE.md — Drover Technical Reference

Drover is an open-source, config-driven simulation harness that runs AI-driven personas through a web app to surface bugs, confusing flows, and performance problems. The full product/architecture spec is in **`CONTEXT.md`** in this repo root — read it in full at the start of every session before doing anything else. This file is the technical map of what actually exists in the codebase and the decisions that shaped it; CONTEXT.md is the spec, this file is the as-built reality. Where the two conflict, treat CONTEXT.md as the intended design and this file (plus `BUILD-STATE.md`'s decisions log) as what was actually implemented and why it may differ.

Also read `BUILD-STATE.md` (current status, decisions log, pending user input) and skim `GAPS.md` / `TREELINE-GAPS.md` (known blind spots) before making non-trivial changes — several "obvious" improvements are already logged there as deliberate post-v1 deferrals.

---

## Build status

Sessions 1–5 of the original build plan are done: core types + SQLite layer, browser harness + treeLine adapter, the actor tier (LLM persona loop), the discovery-mode orchestrator, and the analyst tier (cross-session pattern mining). See `BUILD-STATE.md` for the authoritative, up-to-date status, the full decisions log, and the exact next step.

**Not yet built:** reporting (`src/report/`, markdown report generation + `drover report` CLI), Stampede mode (`src/stampede/`, scripted load replay), the example domain packs and README quickstart (`examples/`, full README), the real Horse Haven Ops domain pack, and a validation run against Horse Haven staging. These map to the original plan's Session 6–9 scope. Treat CONTEXT.md's relevant sections ("Reporting," "Stampede mode," "Open source packaging") as the spec for that work when it's picked up.

No `ANTHROPIC_API_KEY` has been available in any build environment so far — every real-model code path (actor tier, analyst tier's Batch API) is implemented and covered by scripted/mocked tests, but has never been exercised against a live model. The smoke scripts (`npm run smoke:actor`, `smoke:orchestrator`, `smoke:analyst`) detect the missing key and skip gracefully rather than failing. Run them with a real key before trusting real-model behavior.

---

## Non-negotiable constraints (from CONTEXT.md — do not re-decide these)

- **Phase 1 scope only.** No fixer tier, no quorum, no auto-promotion of findings, no CI/scheduled runs, no accessibility/visual-drift modules, no installable domain-pack packages. If tempted, log the idea in `GAPS.md` and move on.
- **Sequential persona execution** is the default (`concurrencyCap` unset or `1`) — `runDiscovery` now also supports real bounded concurrency above 1 via a worker-pool scheduler (GAPS fix; see the orchestrator section below), but sequential stays the default path and the only path with an *exact* budget ceiling guarantee. An invalid `concurrencyCap` (not a positive integer) still throws before the run row is written (`InvalidConcurrencyCapError`, checked before `db.insertRun` — same timing as `assertDataPolicyAllowed`), same guardrail spirit as the old guard, just validating shape instead of rejecting concurrency outright.
- **SQLite only** for Drover's data, fully separate from any target app's database.
- **Zero write access to anything external:** no auto-filed GitHub issues, no writes to the target app's data stores beyond what personas do through the UI, and staging teardown wipes everything a run created.
- **Never run against production.** Staging with synthetic data only. The Horse Haven target is `volunteer.horsehaventn` staging.
- **Secrets never enter prompt content.** Auth tokens, cookies, API keys live in the orchestrator's HTTP layer only, regardless of provider. `fill()` primitive values are never written to the event log either (only the selector) — same principle applied one layer deeper.
- **`dataPolicy` is enforced, not advisory:** `restricted` packs must refuse to run with a non-approved provider configured for the actor tier. Implemented as `assertDataPolicyAllowed` in `src/actor/provider.ts`; approved-provider set for `restricted` is `["anthropic", "ollama"]` — `ollama` runs against a local/self-hosted server (`OllamaModelProvider`), the zero-exposure alternative CONTEXT.md names explicitly (see `GAPS.md` for what's still unverified: it hasn't been run against a real Ollama install).
- **Budget knobs are load-bearing:** hard per-run dollar ceiling (graceful shutdown, never dies mid-write — checked *between* sessions, never mid-session) and soft per-persona-session cap. Both implemented. The analyst tier also has an optional hard ceiling (`BudgetConfig.analystCeilingUsd`), enforced as a pre-flight cost *estimate* checked before its single Batch call is sent (`src/analyst/budget.ts`) — a Batch request is billed the instant it's submitted, so there's no mid-call point to cap it at the way `SessionBudget` can for a multi-action session.
- **Config is typed TypeScript** (`sim.config.ts`), not JSON/YAML. License is MIT. Single package, no monorepo.
- **Reasoning capture is one sentence per action**, not chain-of-thought. Screenshots/traces only at the moment a finding is flagged — never on every action.

---

## Architecture & module map

Three tiers per CONTEXT.md — **actor** (drives the browser, one persona/goal at a time), **analyst** (post-hoc cross-session pattern mining), **fixer** (Phase 2, not built). Two execution modes — **discovery** (LLM-reasoning personas, built) and **Stampede** (scripted load replay, not built).

```
src/
  types/          Core schema: PersonaArchetype, WeightedGoal, Goal, Checkpoint, DomainPack,
                   ActionEvent, finding types, SimConfig, run/session status enums.
                   Barrel: src/types/index.ts
  db/              better-sqlite3 layer. database.ts = DroverDb class (all reads/writes),
                   migrations.ts = schema. Tables: runs, sessions, action_events,
                   in_session_findings, cross_session_findings, finding_status_history.
  browser/         Playwright wrapper. session.ts = BrowserSession (per-session isolated
                   context, device emulation, action primitives, passive console/HTTP-failure
                   listeners). device.ts = pinned device presets. screenshot.ts = capture
                   utility (never throws).
  treeline/        adapter.ts — TreelineAdapter interface, real integration (dynamic import
                   of the sibling treeLine checkout) + stub fallback.
  actor/           The perceive→decide→act loop. loop.ts = runPersonaSession (the entry
                   point). provider.ts = ModelProvider interface + AnthropicModelProvider +
                   ScriptedModelProvider (test double) + dataPolicy enforcement. prompt.ts =
                   static/cacheable system block + per-action user block. checkpoint.ts =
                   detector DSL (url:/selector:/text:). route-map.ts = familiarity-gated
                   treeLine route context. budget.ts = pricing table + SessionBudget soft-cap.
                   findings.ts = recordInSessionFinding.
  matching/        match-key.ts — computeMatchKey/normalizeRoute, the cross-run finding
                   identity shared by actor findings and orchestrator reconciliation.
  orchestrator/    schedule.ts = buildSchedule (org size × weeks × frequency → week-major
                   sequential schedule) + drawWeightedGoal. reconcile.ts =
                   reconcileRunFindings (new/still-open/resolved tagging). run-discovery.ts =
                   runDiscovery, the discovery-mode entry point (dataPolicy enforcement,
                   per-session isolation, budget ceiling, teardown, reconciliation).
                   config-loader.ts = loadDefaultExport for .ts domain packs/sim configs.
  analyst/         digest.ts = buildSessionDigest (derived metrics from raw timestamps,
                   capped action trace). prompt.ts = single-shot analyst prompt. provider.ts =
                   AnalystProvider interface + BatchAnalystProvider (real Anthropic Batch API
                   lifecycle) + ScriptedAnalystProvider. validate.ts = structured-output
                   validation (malformed findings logged + skipped, never crash). budget.ts =
                   pre-flight cost estimate + AnalystBudgetExceededError for the optional
                   analystCeilingUsd hard cap. analyze.ts = runAnalyst, the entry point.
  cli/             index.ts — commander-based CLI. Commands so far: `drover run`,
                   `drover analyze`.
  report/          NOT YET BUILT.
  stampede/        NOT YET BUILT.
  archetypes/       NOT YET BUILT (ships in examples/ per plan — see CONTEXT.md persona layer).
```

Barrel exports: each subdirectory has an `index.ts`; `src/index.ts` re-exports the public surface.

---

## Key implementation decisions

These are decisions CONTEXT.md left open that got resolved during the build. Full rationale for each lives in `BUILD-STATE.md`'s decisions log (dated entries) — this is a condensed index by topic. **Read the full entry before changing any of these**, since several have non-obvious reasons.

**Tooling & environment**
- Linter/formatter: **Biome**, not ESLint (`biome.json` — must include `scripts/**` in `files.includes`, this was a real bug once already).
- `better-sqlite3` pinned to `^12.11.1` (not v13 — v13 dropped prebuilt binaries and this machine has no MSVC toolchain).
- Package is ESM (`"type": "module"`), Node >=20, strict TS with `exactOptionalPropertyTypes`.
- `tsx` is a regular (not dev) dependency — the compiled CLI needs `tsx/esm/api`'s `register()` at runtime to dynamically import a user's `.ts` config files.

**Schema & IDs**
- IDs are UUIDs (`newId()` in `src/db/database.ts`). Callers supply IDs for every entity *except* action events — `insertActionEvent` generates and returns the id.
- Both finding tables carry `match_key TEXT NOT NULL`; `finding_status_history` is keyed `(match_key, run_id)` and `recordFindingStatus` is an **upsert**, not insert-only (needed once the analyst tier's second reconciliation pass could hit the same key twice — see the two-phase reconciliation gap below).
- Run statuses: `running|completed|budget-stopped|crashed`. Session statuses: `running|completed|hard-stopped|budget-capped`. In-session finding types: `console-error|http-failure|action-budget-exhausted|hard-stop`. Cross-session finding types: `duplicate-label|repeated-stumble-route|slow-checkpoint|recurring-dead-end`. All enforced by CHECK constraints — extending any list means a new migration.
- `ActionEvent.checkpointId` **is populated**: the actor loop (`src/actor/loop.ts`) evaluates checkpoints again right after a primitive action successfully lands, and tags that action's already-inserted event via `DroverDb.updateActionEventCheckpoint` with the first newly-satisfied checkpoint id (an UPDATE, not part of `insertActionEvent`, since satisfaction is only knowable after the action's effect is on the page). If one action satisfies more than one checkpoint at once, only the first (goal order) gets tagged on that event; all of them still count toward the session's `reachedCheckpointIds`. The analyst tier's digest (`src/analyst/digest.ts`) now consumes this via `SessionDigest.checkpointReachTimesMs` (`Record<checkpointId, elapsedMsFromSessionStart>`, first-reach-wins), surfaced in the analyst prompt as a per-session "Checkpoint reach times" block so `slow-checkpoint` findings can compare true per-checkpoint latency across sessions sharing a checkpoint id. The "abnormally high action count" half of `slow-checkpoint` still uses the older whole-session-duration-by-goal comparison. Checkpoint ids are no longer opaque to the analyst: `Run.checkpointContext` (`src/types/run.ts`, optional, stored via migration-2's `checkpoint_context_json` column) snapshots each checkpoint id's owning `Goal.id` and `Checkpoint.description` at run-creation time (`buildCheckpointContext` in `src/orchestrator/run-discovery.ts`), and `buildAnalystUserPrompt` (`src/analyst/prompt.ts`) renders it inline next to each reach time when available, falling back to the bare id for pre-migration runs or an id the map doesn't cover. Residual gap: still no position-within-goal ordering context (see `GAPS.md`).

**Cross-run finding matching**
- Real match key lives in `src/matching/match-key.ts`: `${type}:${normalizedRoute}`, optionally suffixed `:${method}`. `normalizeRoute` strips origin/query/hash — deliberately host-independent so the same route matches across runs even if a dev/staging port changes.
- Reconciliation scopes "prior runs" to the same `DomainPack.appName`. A match key already `resolved` is left alone on subsequent absent runs (avoids resolved-record spam).
- Reconciliation is **two-phase**: `runDiscovery` reconciles right after a run finishes (only in-session findings exist yet), and `runAnalyst` reconciles again after cross-session findings are written. `reconcileRunFindings` takes a `ReconcileOptions.crossSessionDataComplete` flag (default `true`) — `runDiscovery`'s call passes `false`, which skips resolving prior open cross-session-typed match keys entirely (rather than marking them `resolved` just because this run's cross-session findings don't exist yet) until `runAnalyst`'s later call, which keeps the default `true`. This means the console summary `drover run` prints is accurate immediately; a cross-session-typed match key just stays at whatever status it already had until `drover analyze` actually runs and produces real data to reconcile against — there's no interim incorrect `resolved` tag anymore. A future reporting feature should still flag runs with no analyst pass yet, since those match keys have no reconciled status update at all until then.

**Browser / treeLine**
- treeLine loads via **runtime dynamic import**, not a package.json dependency — `createTreelineAdapter()` imports `../treeLine/packages/acquire/dist/index.js` (override with `DROVER_TREELINE_PATH`), falling back to a stub. `@treeline/acquire` is unpublished; a `file:` dep would break `npm install` for anyone without the sibling checkout. Real integration works when the sibling repo (`C:\Users\james\Documents\treeLine`) is built.
- Event stream action types: primitives `navigate|click|fill|read-page`; observations `console-error|page-error|http-failure`; `action-error` when a primitive throws.
- HTTP responses ≥400 are logged as `http-failure` events; only 5xx becomes an in-session *finding*.
- Device emulation presets are pinned in `src/browser/device.ts` (not Playwright's device registry by name) for stability across Playwright upgrades.

**Actor tier**
- Default actor model: `claude-haiku-4-5` (`DEFAULT_ACTOR_MODEL` in `src/actor/provider.ts`) — this is the project's own explicit spec from CONTEXT.md's model routing table, not a generic default.
- `OllamaModelProvider` (`src/actor/provider.ts`) is the second `ModelProvider` implementation, alongside Anthropic — local/self-hosted via Ollama's `/api/chat` with an OpenAI-style `tools` array, reusing the same `decide_action` schema and `parseDecision` the Anthropic path uses. Base URL defaults to `http://localhost:11434`, overridable via the `OLLAMA_HOST` env var or an explicit constructor `baseUrl`. Cost is always `0` (no per-token billing for a local model) — deliberately doesn't run through `computeCostUsd`/`PRICING`. A model with no tool-calling support yields `MalformedDecisionError` rather than a crash, same treatment as Anthropic's "no tool_use block" case. Not yet exercised against a real Ollama install (see `GAPS.md`).
- `patience`/`techSavviness` traits are treated as **0..1 normalized** (CONTEXT.md doesn't specify a range). `patience` → `maxRetries = round(1 + patience*4)` and `pacingMs = round((1-patience)*500)`. Codified explicitly for domain-pack authors in `README.md`'s "Writing a domain pack" section (`patience`/`techSavviness` are annotated `0..1` in the schema block there, with a callout not to assume a 1–10 scale) — this already covers the authoring-guide need Session 8's `examples/` work would otherwise have had to add.
- Checkpoint detector DSL: `kind:value` — `url:<substring>`, `selector:<css>`, `text:<substring, case-insensitive>` (`src/actor/checkpoint.ts`, documented in `README.md`). Intentionally minimal — no regex, no visibility-vs-presence distinction, no AND/OR combining. Extend the DSL rather than working around it with extra checkpoints if a real domain pack needs more.
- Structured decision output is a forced Anthropic tool call (`tool_choice: {type:"tool", name:"decide_action"}`) — never free-text parsing. `MalformedDecisionError` (`src/actor/provider.ts`) carries the billed `usage`/`costUsd` from the API response whenever one exists — `AnthropicModelProvider.decide()` computes cost from `response.usage` before attempting to parse the tool call, so a malformed `decide_action` payload (which Anthropic still bills) doesn't lose its cost. `runPersonaSession`'s retry catch block (`src/actor/loop.ts`) records that cost against `SessionBudget`/`totalCostUsd` even on a failed attempt, not just successful ones.
- "One sentence per action" (the non-negotiable constraint above) is enforced, not just requested: `DECIDE_TOOL.input_schema.properties.reasoning` (`src/actor/provider.ts`) carries `maxLength: MAX_REASONING_LENGTH` (200) as a hint to the model, and `parseDecision` truncates (never rejects) any `reasoning` string longer than that before it's stored — a model that drifts into a multi-paragraph explanation gets its stored `reasoning` clipped to one short passage instead of the session crashing on prompt-adherence drift. A multi-field chain-of-thought shape was already structurally impossible (`ActorDecision`/`ActionEvent` only ever have a single `reasoning: string` field); this closes the remaining length half.
- Prompt caching (`cache_control: {type:"ephemeral"}`) applies to the static system block only (domain pack + archetype + checkpoints + optional route map). Below Haiku 4.5's ~4096-token minimum cacheable prefix this silently doesn't cache — fine for the toy example, worth checking once a real domain pack's static block grows.
- `action-budget-exhausted` only fires when a goal's action budget is genuinely exhausted by the loop's own exit, not when a persona voluntarily gives up early (`outcome: "gave-up"`) — CONTEXT.md's four finding types have no "gave up early" type; a candidate fifth type if real runs show it matters.

**Orchestrator**
- `runDiscovery` validates `config.concurrencyCap` before doing anything else (before `db.insertRun`, alongside `assertDataPolicyAllowed`): unset or a positive integer proceeds, anything else (0, negative, fractional, NaN) throws `InvalidConcurrencyCapError` (`src/orchestrator/run-discovery.ts`, exported from the orchestrator barrel). Above that guard, `runDiscovery` runs a bounded worker pool (`min(concurrencyCap, schedule.length)` workers, each repeatedly claiming the next unclaimed schedule entry in order) — a `concurrencyCap` of 1 (or unset, the default) still runs exactly one worker, identical to the pre-concurrency sequential loop. See GAPS.md for the one real trade-off this introduces: the run-level budget ceiling becomes best-effort (checked before *launching* each new session, not continuously) once `concurrencyCap > 1`, since other sessions can already be in flight when the ceiling is crossed.
- Schedule iteration is **week-major** (all of week 1 across every simulated org member, before week 2), not persona-major — chosen to more faithfully simulate "an org's activity over N weeks." `orgSize` members are round-robin assigned archetypes from `domainPack.personas`; instance numbers (`p1#1`, `p1#2`, ...) stay stable per member across weeks. Concurrency doesn't change this ordering — workers still *claim* schedule entries strictly in this order, they just don't wait for one entry to finish before claiming the next.
- Per-session isolation covers two failure shapes identically (session continues as `hard-stopped`, batch continues): the actor loop's own hard-stop, and an exception escaping session setup entirely (counted separately as `sessionsErrored` vs `sessionsHardStopped`). Only an error escaping the *persona/goal lookup itself* (a config bug, e.g. a schedule referencing a missing goal id) marks the whole run `crashed` — every worker stops claiming new work once this happens (a shared `stopLaunching` flag), sessions already in flight are allowed to finish, then teardown and reconciliation still run first, finally-style.
- `DomainPack.teardown?: (ctx: DomainPackTeardownContext) => Promise<void>` is a field Session 4 added that isn't in CONTEXT.md's verbatim schema (needed for "wipes everything a run created"). `DomainPackTeardownContext` is just `{ runId, targetBaseUrl }` — Drover has no record of which app-side rows a run actually created, so a pack author's teardown must self-correlate (tag synthetic data with `runId` at fill-time, or sweep by timestamp window). Worth revisiting once a real teardown (Horse Haven pack) is implemented.
- CLI config/domain-pack loading: plain TS modules with a **default export**, loaded via `loadDefaultExport`.

**Analyst tier**
- One Batch API call per `drover analyze` invocation, covering every session in the run in a single prompt (not chunked, not per-session). Revisit if a real run's session count makes one prompt unwieldy.
- `computeCostUsd` doesn't know about Batch API's 50% discount; `BatchAnalystProvider` applies `BATCH_DISCOUNT = 0.5` itself after calling the shared pricing function.
- Cross-session finding evidence (`screenshotPath`/`traceSnippet`) is **borrowed, not captured** — the analyst has no live browser, so it takes the first available screenshot from any of the finding's referenced sessions' own in-session findings, if one exists. Best-effort; ships without a screenshot otherwise.
- `drover analyze` requires `--db <path>` (no default, unlike `drover run`) since a run id alone doesn't say which SQLite file it lives in. It does *not* need a `--config` flag — the analyst `ModelRoute` comes from the `Run` row's own stored config snapshot.
- Optional `BudgetConfig.analystCeilingUsd` hard-caps the single Batch call. Enforced pre-flight in `runAnalyst` (`src/analyst/analyze.ts`): `estimateAnalystCostUsd` (`src/analyst/budget.ts`, now `async`) counts input tokens via Anthropic's real, free `messages.countTokens` endpoint (`createApiTokenCounter`) — the exact `system`+`messages` shape the real Batch request sends, not a proxy — and the request's `max_tokens` ceiling for output, Batch-discounted the same as the real call. If the estimate exceeds the configured ceiling, `AnalystBudgetExceededError` throws before `provider.analyze()` is ever called, so nothing is billed. Unset ceiling preserves the old uncapped behavior. A `TokenCounter` is injectable (default param) so tests/offline runs can avoid a real network call; any failure of the real API path (missing credentials, offline) falls back to the old chars/4 heuristic (`estimateTokens`) rather than blocking the gate — see `GAPS.md` for what's still unverified against a live API.

---

## Known gaps (see `GAPS.md` and `TREELINE-GAPS.md` for full detail)

Highest-signal ones to know about before extending the codebase:

- No local/self-hosted (Ollama) provider yet — `restricted` domain packs can only run actor-tier on Anthropic today.
- `SimConfig.concurrencyCap > 1` runs a real bounded worker pool now, but the run-level budget ceiling becomes best-effort (not exact) once concurrency is above 1 — see `GAPS.md`.
- The analyst tier's digest now computes true per-checkpoint latency from `ActionEvent.checkpointId` (`checkpointReachTimesMs`), but the checkpoint is only ever identified by its raw id string — no description or goal-position context reaches the analyst.
- The analyst tier's `analystCeilingUsd` budget cap is a pre-flight character-count-based estimate, not exact token accounting.
- treeLine's auth-wall detection and route-map crawl aren't exported as standalone/reusable surfaces — Drover's adapter re-implements a cheap password-field heuristic and approximates a route map via single-page link scraping instead of a real crawl. See `TREELINE-GAPS.md` for the asks that should eventually become treeLine issues.
- treeLine is not consumable as a normal npm dependency (unpublished workspace package) — loaded via runtime dynamic import of the sibling checkout's built `dist/`, with a stub fallback if missing/unbuilt.

---

## Running things

```
npm run build           # tsc
npm run typecheck       # tsc -p tsconfig.typecheck.json
npm test                # vitest run
npm run lint             # biome check src tests scripts
npm run smoke            # hardcoded browser-only sequence against a fixture site (no LLM)
npm run smoke:actor      # one real-model persona-session (needs ANTHROPIC_API_KEY)
npm run smoke:orchestrator  # full CLI subprocess run against the fixture site
npm run smoke:analyst    # fixture run + real Batch API analyst pass (needs ANTHROPIC_API_KEY)
npm run drover -- run <domain-pack> [--config sim.config.ts] [--out path]
npm run drover -- analyze <run-id> --db <path> [--poll-interval-ms <ms>]
```

`tests/fixtures/site.ts` is a self-contained local fixture site (nav, form, login, dashboard, console-error page, 500 endpoint) — used by both tests and smoke scripts so nothing depends on network access or Horse Haven staging being reachable. `SMOKE_URL=<url>` points smoke scripts at a real target instead.

Repo locations for sibling dependencies:
- **treeLine**: `C:\Users\james\Documents\treeLine` (pnpm workspace, code under `packages/`).
- **Horse Haven Ops** (the eventual real target): `C:\Users\james\Documents\volunteer-ops`.

---

## Working conventions

- Keep `BUILD-STATE.md` current: what exists, pending user input (credentials, staging access), and a decisions log entry (with one-line rationale) for anything this file doesn't already dictate.
- Log Drover's own shortcomings to `GAPS.md` and treeLine-specific limitations to `TREELINE-GAPS.md` as they're found — both are meant to accumulate over the life of the project, not just during initial build-out.
- Never end a change with a broken build or failing tests — `tsc --noEmit`/`tsc` and `vitest run` clean, `biome check` clean.
- Prefer scripted/mocked model providers (`ScriptedModelProvider`, `ScriptedAnalystProvider`) for test coverage of loop mechanics; reserve real-model smoke scripts for confirming actual model behavior when credentials are available.
