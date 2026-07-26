# Drover

[![test](https://github.com/jamesmyers4/Drover/actions/workflows/test.yml/badge.svg)](https://github.com/jamesmyers4/Drover/actions/workflows/test.yml)

Drover is an open-source, config-driven simulation harness that runs AI-driven personas through a web app to surface bugs, confusing flows, and performance problems — the messy, unscripted issues that scripted tests don't catch because nobody predicted them. Point it at any web app via a **domain pack**; Horse Haven Ops (`volunteer.horsehaventn`) is the first real target and reference implementation.

Two AI tiers currently exist: an **actor** tier that drives a real browser one persona-session at a time (perceive → decide → act, LLM-reasoned), and an **analyst** tier that mines patterns across a completed run's sessions after the fact. A **fixer** tier (auto-proposing code fixes) is explicitly Phase 2 and not part of this codebase yet. See `CONTEXT.md` for the full product spec and `CLAUDE.md` for the as-built architecture map — this README is the practical entry point.

**Status:** Sessions 1–8 of the build are done (types/DB, browser harness, actor tier, discovery orchestrator, analyst tier, markdown reporting, Stampede load mode, core archetypes + toy example domain pack). Not yet built: the real Horse Haven Ops pack and a validation run against Horse Haven staging. See `SESSION-LOG.md` for the full dated history and `GAPS.md` for known blind spots.

## What it does today

**Discovery mode** — the only execution mode implemented so far. Given a domain pack (personas + goals + checkpoints) and a `sim.config.ts` (run dimensions, budget, model routing), Drover:

1. Expands a schedule: `orgSize` simulated org members × `simulatedWeeks` × `sessionsPerPersonaPerWeek`, week-major (all of week 1 across every member before week 2), personas round-robin assigned from the pack.
2. Runs persona-sessions **sequentially by default** — or through a bounded worker pool if `concurrencyCap` is set above 1 (see [Concurrency](#concurrency) below) — through a real Playwright browser, driven by an LLM (default `claude-haiku-4-5`) deciding one action at a time against a forced structured tool call — never free-text parsing.
3. Logs every action (navigate/click/fill/read-page), console errors, page errors, and HTTP failures (≥400) as raw-timestamp events, plus a one-sentence reasoning annotation per action — never full chain-of-thought.
4. Flags **in-session findings** live: console errors, HTTP 5xx, a checkpoint never reached within budget, or a hard-stop. A screenshot + short trace snippet is captured only at the moment a finding fires.
5. Enforces a run-level hard dollar ceiling (checked between sessions, never mid-write) and a per-session soft cap (session ends `budget-capped`, not a crash). `drover analyze`'s Batch call(s) have their own optional hard ceiling (`budget.analystCeilingUsd`), checked pre-flight against an estimated cost summed across every chunk — a Batch call is billed the instant it's submitted, so there's no mid-call point to cap it at.
6. Tears down anything the run created (via the domain pack's optional `teardown` hook) and reconciles findings against prior runs of the same app (`new` / `still-open` / `resolved`).

**Cross-session analysis** — a separate `drover analyze <run-id>` command loads every session from a completed run, builds a compact digest per session (derived metrics + capped action trace + in-session findings), and sends them to Sonnet via the real Anthropic **Batch API** (50% off, no latency requirement — this is post-hoc analysis). Digests are split into groups of at most `--sessions-per-chunk` (default 25) sessions, each its own concurrent Batch request, rather than one prompt covering every session — keeps a large run's prompt size bounded, at the cost of only correlating patterns *within* a chunk (a pattern spanning two sessions in different chunks would be missed; see [Concurrency](#concurrency) for the analogous trade-off on the actor-tier side). It looks for patterns no single actor session would notice: duplicate dead-end labels, a route several personas independently stumble on, a checkpoint that's technically reachable but abnormally slow. Malformed model output is validated, logged, and skipped — it never crashes the run. Findings are reconciled a second time once written, since cross-session findings don't exist until `analyze` has run (see [Cross-run finding matching](#cross-run-finding-matching) below).

**Reporting** — `drover report <run-id> --db <path> [--out report.md]` reads a run's SQLite data (no re-simulation, no re-analysis) and builds a markdown report: a findings summary table (severity, type, session count, status), the same findings broken out by flow (`Goal.id`), run metadata (config dimensions, actual actor/analyst spend vs. budget), a "since last run" new/still-open/resolved count, and a "Load test results (Stampede)" section folding in every `drover stampede` run recorded against this discovery run (percentiles/error rates per route/concurrency, one subsection per replay). Findings from both tables merge into one row per `matchKey`; each row links to its evidence (screenshot paths, event ids) in a separate appendix rather than inlining it. Prints to stdout without `--out`. Surfaces a warning when `drover analyze` hasn't run yet for the run, since cross-session findings/status may be incomplete until it has.

**Stampede mode** — a distinct `drover stampede <run-id> --db <path>` command: scripted, non-reasoning replay of routes a *discovery* run already found, at increasing concurrency. No LLM calls anywhere — the only real safety property to know is that the target is always the source run's own `targetBaseUrl`, never an arbitrary URL you pass in. It pulls the distinct `navigate` targets a discovery run recorded, then for each `--concurrency` level (default `1,5,10`, run one at a time so the comparison is clean) spins up that many independent browser contexts, each making `--iterations-per-worker` (default 3) timed passes through every route. Results — sample count, error count, and p50/p95/p99 response times per (route, concurrency) pair — go to their own `stampede_runs`/`stampede_route_results` tables (not the discovery `runs`/`sessions`/`action_events` tables, which have no natural home for load-test traffic) and print to the console. Needs no credentials at all — `npm run smoke:stampede` runs it for real, unlike every other smoke script.

## What it doesn't do yet

Only a page's own `navigate` targets get replayed by Stampede — not full click/fill goal sequences, since that would mutate app data at load-test volume with no teardown to clean it up. See `GAPS.md`.

## Quickstart

```bash
npm install
npx playwright install chromium   # first time only

npm run build          # tsc
npm test                # vitest run
npm run lint             # biome check src tests scripts

# Hardcoded browser-only sequence against a local fixture site — no LLM, no API key needed
npm run smoke
```

`examples/` ships a full end-to-end example — a toy target app plus a `DomainPack`/`SimConfig` pair that drives it — so you can see the whole pipeline run before writing your own. In one terminal:

```bash
npm run example:serve   # starts the toy app at http://127.0.0.1:4173
```

In another, with a real `ANTHROPIC_API_KEY` exported:

```bash
export ANTHROPIC_API_KEY=sk-...
npm run drover -- run examples/toy-app/domain-pack.ts --config examples/toy-app/sim.config.ts --out runs/example1.sqlite
npm run drover -- analyze <run-id> --db runs/example1.sqlite
npm run drover -- report <run-id> --db runs/example1.sqlite --out runs/example1-report.md
```

The toy app has one intentional bug (a "Load more" button on `/horses` that always 500s) so the resulting report has something real to show, not just a happy path. Without a key, every session still runs through the full scheduling/budget/teardown/reconciliation pipeline and hard-stops gracefully on the missing credential — the same degrade-gracefully behavior `npm run smoke:orchestrator` relies on — so `drover run`/`drover report` are worth trying even without one.

Once you're ready to point Drover at your own app, write your own `DomainPack` and `SimConfig` (see [Writing a domain pack](#writing-a-domain-pack) below — `examples/toy-app/domain-pack.ts` is a fork-friendly starting point) and swap the paths above:

```bash
export ANTHROPIC_API_KEY=sk-...
npm run drover -- run ./my-domain-pack.ts --config ./sim.config.ts --out ./runs/run1.sqlite
npm run drover -- analyze <run-id> --db ./runs/run1.sqlite
npm run drover -- report <run-id> --db ./runs/run1.sqlite --out ./runs/report1.md
npm run drover -- stampede <run-id> --db ./runs/run1.sqlite --concurrency 1,5,10
```

`npm run smoke:actor`, `smoke:orchestrator`, and `smoke:analyst` exercise the actor loop, the full orchestrator (as a real CLI subprocess), and the analyst's Batch API lifecycle respectively — the first and third need `ANTHROPIC_API_KEY` and print a clear skip message and exit 0 without it; `smoke:orchestrator` runs regardless (every session just hard-stops on the missing key, which itself exercises per-session isolation). `npm run smoke:stampede` needs no credentials at all — Stampede has no LLM calls in it.

## Writing a domain pack

A domain pack is a plain TypeScript module with a **default export** of shape `DomainPack` (`src/types/domain-pack.ts`), loaded from a local file path — not an installable package (that's an explicit non-goal for v1). Two schema layers:

**Generic archetype layer** (reusable across any target app):

```typescript
interface PersonaArchetype {
  id: string;
  name: string;
  traits: {
    patience: number;       // 0..1 — see note below
    techSavviness: number;  // 0..1 — see note below
    deviceType: "mobile" | "desktop" | "tablet";
    familiarity: "new" | "returning" | "veteran";
  };
}

interface WeightedGoal {
  goalId: string;
  weight: number;
}
```

`patience` and `techSavviness` are **0..1 normalized** — this is a Drover convention, not spelled out in the core type (which is a bare `number`). `patience` maps to `maxRetries = round(1 + patience*4)` and a pacing delay between actions (`pacingMs = round((1-patience)*500)`); `techSavviness` shapes how the persona is framed in the prompt. Use this scale when authoring traits, not e.g. 1–10.

A core archetype set ships with the tool itself — `examples/archetypes.ts` exports `impatientRushed`, `firstTimerCautious`, `distracted`, and `powerUserMobile` (also as `CORE_ARCHETYPES`, an array of all four). Import and reuse them in your own domain pack rather than inventing pack-specific traits from scratch — this is the actual reuse value CONTEXT.md's persona layer is for. `examples/toy-app/domain-pack.ts` shows all four wired into one pack's `goalWeightsByPersona`.

**App-specific layer** (one file per target app):

```typescript
interface Goal {
  id: string;
  description: string;
  actionBudget: number;
  checkpoints: Checkpoint[];
  successCheckpointId: string;
}

interface Checkpoint {
  id: string;
  description: string;
  detector: string;   // see "Checkpoint detector DSL" below
}

interface DomainPack {
  appName: string;
  personas: PersonaArchetype[];
  goals: Goal[];
  goalWeightsByPersona: Record<string, WeightedGoal[]>;
  dataPolicy: "synthetic-only" | "restricted";
  teardown?: (ctx: {
    runId: string;
    targetBaseUrl: string;
    runStartedAt: number;   // epoch ms
    runEndedAt: number;     // epoch ms, taken right as teardown is invoked
  }) => Promise<void>;
}
```

Each persona draws from a **weighted goal pool** per session rather than one fixed flow — this is what makes a run reflect "what do real users actually do, in what proportions" instead of testing a single scripted path.

`teardown` is optional and runs finally-style after a completed/budget-stopped/crashed run alike. Drover keeps no record of which app-side rows a run actually created, so correlating and deleting them is the pack author's responsibility, via one of two strategies: tag synthetic data with the `runId` at fill-time (needs nothing further from Drover), or sweep by timestamp window using `runStartedAt`/`runEndedAt` (which Drover provides precisely so this doesn't need separate SQLite access from inside the hook).

### Checkpoint detector DSL

A `Checkpoint.detector` is a string of the form `kind:value`, evaluated against the live page after each actor action (`src/actor/checkpoint.ts`). Three kinds:

| Kind | Example | Matches when... |
| --- | --- | --- |
| `url:` | `url:/dashboard` | the current page URL contains the substring |
| `selector:` | `selector:#confirmation-banner` | an element matching the CSS selector exists on the page |
| `text:` | `text:thank you for signing up` | the page's visible body text contains the substring (case-insensitive) |

Detectors are Drover's own instrumentation for measuring progress — they are never shown to the persona/model, which only ever sees each `Checkpoint.description`. This is intentionally minimal (no regex, no visibility-vs-presence distinction, no AND/OR combining) — extend the DSL rather than working around it if a real pack needs more.

## `sim.config.ts`

```typescript
interface SimConfig {
  targetBaseUrl: string;         // staging only, never production
  runDimensions: {
    orgSize: number;
    simulatedWeeks: number;
    sessionsPerPersonaPerWeek: number;
  };
  budget: {
    runCeilingUsd: number;         // hard ceiling, checked between sessions
    perSessionSoftCapUsd: number;  // soft cap, ends one session gracefully
    analystCeilingUsd?: number;    // hard ceiling for `drover analyze`'s Batch call(s), checked pre-flight
  };
  modelRouting: {
    actor: { provider: string; model: string };
    analyst: { provider: string; model: string };
  };
  concurrencyCap?: number;  // exists in the type; see Concurrency below
}
```

## Data routing & privacy

Actor-tier model choice is a per-domain-pack decision (`dataPolicy`), never a silent default, and it's **enforced**, not advisory:

- **`synthetic-only`** domain packs (e.g. Horse Haven Ops, seeded with fake data only): any provider is an acceptable actor-tier choice, since no real person's data is at risk.
- **`restricted`** domain packs (any app touching real personal/legal/medical data): the actor tier must run on an approved provider — currently `anthropic` or `ollama` (`assertDataPolicyAllowed` in `src/actor/provider.ts`). `ollama` runs against a local/self-hosted server (`OllamaModelProvider`, default `http://localhost:11434`, override via the `OLLAMA_HOST` env var or an explicit `baseUrl` constructor arg) — nothing leaves the machine, making it the zero-exposure option for a `restricted` pack with no Anthropic budget. Pick a tool-calling-capable local model (e.g. `llama3.1`, `qwen2.5`); one that doesn't support tool calls just surfaces as a `MalformedDecisionError` per attempt rather than crashing the session.
- Regardless of provider or policy, **secrets never enter prompt content**: auth tokens, session cookies, and API keys live only in the orchestrator's HTTP layer. `fill()` primitive values are likewise never written to the event log — only the selector is (same principle, one layer deeper).

## Concurrency

`SimConfig.concurrencyCap` defaults to sequential (unset or `1`) — every persona-session runs one at a time, which avoids parallel LLM-driven browser sessions competing for a dev-tier staging server and keeps cost/behavior easiest to reason about. Set it above 1 to run a real bounded worker pool instead: `min(concurrencyCap, scheduled session count)` workers each claim the next unclaimed schedule entry in order, so sessions genuinely overlap rather than just being permitted to. A non-positive-integer value (0, negative, fractional, `NaN`) is rejected with `InvalidConcurrencyCapError` before the run starts, same as before.

One trade-off to know before raising `concurrencyCap`: the run-level hard dollar ceiling (`budget.runCeilingUsd`) is checked before a worker launches its *next* session, not continuously — at `concurrencyCap` 1 there's only ever one session in flight, so this is exact, same as always. Above 1, up to `concurrencyCap - 1` other sessions can already be in flight (and add their own cost) by the time a worker notices the ceiling was crossed, so actual spend can overshoot the configured ceiling by roughly that many sessions' worth. Tracked in `GAPS.md` if this proves worth tightening later.

## Cross-run finding matching

Findings carry a `matchKey` (`${type}:${normalizedRoute}`, optionally suffixed `:${method}` — `src/matching/match-key.ts`) so the same issue is recognized across separate runs of the same app and tagged `new` / `still-open` / `resolved` rather than reported as a fresh finding every time. Two finding tables exist:

- **`in_session_findings`** — caught live by the actor: `console-error | http-failure | action-budget-exhausted | hard-stop`. References a single event.
- **`cross_session_findings`** — only visible after `drover analyze` has run: `duplicate-label | repeated-stumble-route | slow-checkpoint | recurring-dead-end`. References a set of sessions.

Reconciliation is **two-phase**: `drover run` reconciles right after a run finishes (only in-session findings exist at that point), and `drover analyze` reconciles again once cross-session findings are written. This means the console summary `drover run` prints can be transiently wrong for cross-session-finding types until `analyze` has also been run for that run id — the on-disk table is only guaranteed correct after both commands have run for a given run.

## Environment & safety

- Runs against a live staging deployment, **never production**.
- Staging data is synthetic-only; a domain pack's `teardown` hook wipes what the run created before the next run starts.
- Per-session isolation: one persona hitting a blocking bug halts only that session (`hard-stopped`, full trace kept) — the rest of the batch continues. A blocked session is itself valuable data, not a run-ending failure.
- Zero write access to anything external: no auto-filed GitHub issues, no writes to the target app's data beyond what personas do through its own UI.

## CLI reference

```
drover run <domain-pack> [--config sim.config.ts] [--out path]
drover analyze <run-id> --db <path> [--poll-interval-ms <ms>] [--sessions-per-chunk <n>]
drover report <run-id> --db <path> [--out report.md]
drover stampede <run-id> --db <path> [--concurrency 1,5,10] [--iterations-per-worker 3]
```

- `<domain-pack>` and `--config` are paths to local TypeScript modules with a default export (a `DomainPack` and `SimConfig` respectively). `--out` defaults to `runs/<timestamp>.sqlite`.
- `drover analyze` requires `--db <path>` (no default — a run id alone doesn't say which SQLite file it lives in) and does *not* take a `--config` flag; it reads the analyst model route from the run's own stored config snapshot. `--sessions-per-chunk` defaults to 25 — see [Cross-session analysis](#what-it-does-today) above.
- `drover report` also requires `--db <path>`, same reasoning as `analyze`. Without `--out`, the markdown report prints to stdout; with it, the report is written to that file path instead.
- `drover stampede` also requires `--db <path>`; `<run-id>` is a *discovery* run's id (`drover run`'s output), whose recorded routes and `targetBaseUrl` get replayed. `--concurrency` is a comma-separated list of positive integers tested in order; `--iterations-per-worker` is how many full route-list passes each concurrent worker makes per level.

## Repo layout

```
src/
  types/         Core schema (PersonaArchetype, Goal, DomainPack, ActionEvent, findings, SimConfig, ...)
  db/            better-sqlite3 layer + migrations
  browser/       Playwright wrapper: sessions, device presets, screenshot capture
  treeline/      Adapter to the sibling treeLine project (real integration + stub fallback)
  actor/         The perceive -> decide -> act loop, model providers, prompts, checkpoints, budget
  matching/      Cross-run finding match-key computation
  orchestrator/  Discovery-mode scheduling, weighted goal draw, reconciliation, run-discovery entry point
  analyst/       Post-hoc cross-session pattern mining via the Batch API
  cli/           `drover run` / `drover analyze` / `drover report` / `drover stampede` commands
  report/        Markdown findings report generation from a run's SQLite data
  stampede/      Scripted (non-LLM) load-test replay of a discovery run's discovered routes
examples/
  archetypes.ts  Core PersonaArchetype set shipped with the tool (see "Writing a domain pack")
  toy-app/       A full runnable example: site-server.ts (toy target app with one
                 intentional bug), domain-pack.ts, sim.config.ts — see Quickstart above
```

`tests/fixtures/site.ts` is a self-contained local fixture site (nav, form, login, dashboard, console-error page, 500 endpoint) used by both tests and the smoke scripts, so nothing depends on network access or Horse Haven staging being reachable. Set `SMOKE_URL=<url>` to point smoke scripts at a real target instead. `examples/toy-app/site-server.ts` is a separate, deliberately simpler fixture — it's part of the shipped example an adopter runs and reads, not internal test infrastructure, so it's kept independent of `tests/fixtures/site.ts` even though the pattern is identical.

## Non-goals for v1

Explicitly out of scope until the core simulation concept is proven out — see `CONTEXT.md` for full rationale: no fixer tier (auto code fixes/PRs), no multi-model quorum, no auto-promotion of recurring findings without human review, no accessibility/visual-drift modules, no CI/scheduled runs (manual CLI only), no installable domain-pack packages.

## Further reading

- `CONTEXT.md` — the full product/architecture spec.
- `CLAUDE.md` — the as-built technical map, including every decision CONTEXT.md left open and how it was resolved.
- `SESSION-LOG.md` — dated build history, session by session, plus outstanding pending user input (credentials, staging access).
- `GAPS.md` / `TREELINE-GAPS.md` — known blind spots in Drover and in the treeLine integration, respectively.

## License

MIT
