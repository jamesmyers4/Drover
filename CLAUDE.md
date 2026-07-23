# CLAUDE.md — Drover Build Playbook

You are building **Drover**, an open-source, config-driven simulation harness that runs AI-driven personas through a web app to surface bugs, confusing flows, and performance problems. The full product/architecture spec is in **`CONTEXT.md`** in this repo root. Read it in full at the start of every session before doing anything else. This file tells you *how the build is sequenced*; CONTEXT.md tells you *what to build and why*. Where the two conflict, CONTEXT.md wins on design decisions and this file wins on session sequencing.

---

## How to work in this repo (read every session)

1. **At session start, in order:** read `CONTEXT.md`, read this file, read `BUILD-STATE.md` (created in Session 1). BUILD-STATE.md tells you which session you are in and what the previous session left unfinished.
2. **One session = one scope block below.** Do not start the next session's scope, even if you finish early and even if it seems easy. Finishing early means more polish, tests, and documentation for the *current* scope — not scope creep forward. This is a deliberate control: each session must end in a state a fresh model with zero conversation history can pick up.
3. **Hard stop conditions.** Stop the session immediately (finish the current file edit, commit, update BUILD-STATE.md, then end) when ANY of these hit:
   - The session's "Done means" checklist is fully satisfied.
   - You hit a design question CONTEXT.md doesn't answer and that materially changes the architecture. Log it in `GAPS.md`, mark the session `BLOCKED` in BUILD-STATE.md with the question stated plainly, and stop. Do not guess on architecture-level decisions.
   - Context is getting long and you are less than ~80% through the session scope: checkpoint your progress in BUILD-STATE.md with enough detail to resume, commit working code, and stop.
4. **End-of-session ritual (never skip, even when blocked):**
   - All code compiles (`npm run build` or `tsc --noEmit` passes) and tests pass. Never end a session with a broken build — revert the offending change instead.
   - Commit with a message prefixed by the session number, e.g. `S3: discovery-mode orchestrator loop`.
   - Update `BUILD-STATE.md`: session number, status (`DONE` / `PARTIAL` / `BLOCKED`), what exists now, what's left, any decisions made that CONTEXT.md didn't dictate (with one-line rationale), and the exact next step for the following session.
   - Append anything learned to `GAPS.md` (Drover's own blind spots) or `TREELINE-GAPS.md` (treeLine limitations) per the Learning Loop section of CONTEXT.md.
5. **The user starts each new session manually.** End your final message with: "Session N complete (or blocked). Start a fresh Claude Code session and say: **continue the Drover build**." A fresh session that reads this file + BUILD-STATE.md must be able to continue with no other context.

## Non-negotiable constraints (from CONTEXT.md — do not re-decide these)

- **Phase 1 scope only.** No fixer tier, no quorum, no auto-promotion of findings, no CI/scheduled runs, no accessibility/visual-drift modules, no installable domain-pack packages. If tempted, log the idea in `GAPS.md` and move on.
- **Sequential persona execution** is the default. A concurrency cap may exist as config but is not the default path.
- **SQLite only** for Drover's data, fully separate from any target app's database.
- **Zero write access to anything external:** no auto-filed GitHub issues, no writes to the target app's data stores beyond what personas do through the UI, and staging teardown wipes everything a run created.
- **Never run against production.** Staging with synthetic data only. The Horse Haven target is `volunteer.horsehaventn` staging.
- **Secrets never enter prompt content.** Auth tokens, cookies, API keys live in the orchestrator's HTTP layer only, regardless of provider.
- **`dataPolicy` is enforced, not advisory:** `restricted` packs must refuse to run with a non-approved provider configured for the actor tier.
- **Budget knobs are load-bearing:** hard per-run dollar ceiling (graceful shutdown, never dies mid-write) and soft per-persona-session cap. Build them early (Session 3), not as an afterthought.
- **Config is typed TypeScript** (`sim.config.ts`), not JSON/YAML. License is MIT. Single package, no monorepo.
- **Reasoning capture is one sentence per action**, not chain-of-thought. Screenshots/traces only at the moment a finding is flagged.

## treeLine dependency

Drover consumes treeLine as a library for: Playwright `storageState` session re-seeding, auth-wall detection, and `resolveSeedUrl` crawl-target resolution (see CONTEXT.md "Relationship to treeLine"). **The treeLine repo lives at `C:\Users\james\Documents\treeLine`** (a sibling of this repo — pnpm workspace, code under `packages/`). The Horse Haven Ops target app repo is the sibling **`C:\Users\james\Documents\volunteer-ops`**. Explore treeLine's export surface in Session 2; if its API doesn't expose what's needed, do NOT reimplement it. Define a thin interface (`src/treeline/adapter.ts`) with a stub implementation, log the gap in `TREELINE-GAPS.md`, note it in BUILD-STATE.md, and continue building against the interface.

---

## Session plan

Sessions are ordered so every session ends with something runnable, and the risky integration points (browser driving, LLM loop, treeLine) land early. Estimated count: 8 build sessions + 1 validation session. If a session goes `PARTIAL`, the next session finishes it before advancing — do not renumber, just note it in BUILD-STATE.md.

### Session 1 — Repo scaffold, schemas, and SQLite layer

**Goal:** a compiling TypeScript package with every core type defined and a working database layer, so all later sessions build against stable shapes.

- Init the repo: `git init`, `package.json` (single package, MIT license field), `tsconfig.json` (strict), Vitest for tests, ESLint or Biome (pick one, note choice in BUILD-STATE.md), `.gitignore` (include `*.sqlite`, `runs/`, screenshots dir).
- Create `BUILD-STATE.md`, `GAPS.md`, `TREELINE-GAPS.md` (each with a one-line header explaining its purpose per CONTEXT.md's Learning Loop section).
- `src/types/` — implement every interface from CONTEXT.md's schema section verbatim: `PersonaArchetype`, `WeightedGoal`, `Goal`, `Checkpoint`, `DomainPack`, `ActionEvent`, plus finding types for the two findings tables and a `SimConfig` type for `sim.config.ts` (target base URL, run dimensions: org size × simulated weeks × session frequency, budget knobs, model routing per tier, concurrency cap defaulting to 1).
- `src/db/` — SQLite (use `better-sqlite3`) with migrations for: `runs`, `sessions`, `action_events`, `in_session_findings`, `cross_session_findings`, finding status history (`new | still-open | resolved` per run — status history must be queryable so "open for N runs" is a count, per CONTEXT.md). Raw timestamps only; no derived-metric columns.
- Tests: schema round-trip (insert/read each entity), migration runs clean on empty DB.

**Done means:** `tsc` clean, tests green, all three markdown tracking files exist, BUILD-STATE.md written.

### Session 2 — Browser harness + treeLine adapter (no LLM yet)

**Goal:** a persona-agnostic browser session wrapper that can open the target app, maintain auth, and log `ActionEvent`s to SQLite — driven by a hardcoded script for now.

- `src/browser/` — Playwright wrapper: launch, per-session isolated context, device emulation from `deviceType`, action primitives (click, fill, navigate, read page state) that each emit an `ActionEvent` with raw timestamp.
- `src/treeline/adapter.ts` — interface + implementation (or stub, per the treeLine dependency rule above) for: session re-seeding via `storageState`, auth-wall detection, `resolveSeedUrl`.
- Console error and HTTP-failure listeners wired into the event stream (these become in-session findings in Session 3; for now just log them as events).
- Screenshot capture utility (used later only when findings fire — build the utility, don't wire it to every action).
- A smoke script (`npm run smoke`) that runs a hardcoded 5–10 action sequence against a configurable URL and writes real events to SQLite. Use any public page or a local static page if Horse Haven staging creds aren't available; do not block on staging access — log it in BUILD-STATE.md if missing.

**Done means:** smoke script produces a SQLite file with a session row and correctly-shaped events; treeLine integration status (real vs. stub) recorded in BUILD-STATE.md and TREELINE-GAPS.md.

### Session 3 — Actor tier: the LLM persona loop

**Goal:** one persona, one goal, driven end-to-end by an LLM.

- `src/actor/` — the perceive → decide → act loop: compact page representation in, next action + one-sentence reasoning out, executed through Session 2's primitives. Structured output (tool use or JSON) — never free-text parsing of actions.
- Prompt assembly with **prompt caching**: static block (domain pack, archetype, checkpoint schema) cached per session; per-action block kept small.
- Persona traits actually shape behavior: `patience` bounds retries/waiting, `familiarity` gates whether the treeLine route map is provided as context, `techSavviness` shapes the system prompt.
- Checkpoint detection: evaluate each `Checkpoint.detector` (define the detector format now — recommend: a string DSL of `url:`, `selector:`, `text:` matchers; document it in the README skeleton) after each action.
- In-session findings: console error, HTTP 5xx, action budget exhausted before success checkpoint → write to `in_session_findings`, capture screenshot + trace snippet at that moment only.
- Budget enforcement: token/cost accounting per call; soft per-session cap ends the session gracefully (logged as such, distinct from a hard-stop bug).
- Model client behind a provider interface (default Anthropic Haiku for actor tier) — swappable per config, honoring `dataPolicy` enforcement (refuse `restricted` + non-approved provider at config-load time).
- Test with a scripted/mocked LLM for the loop mechanics; one real-model smoke run against the Session 2 target.

**Done means:** a single persona-session runs end-to-end with a real model, events + reasoning land in SQLite, an artificial failure (e.g., impossible checkpoint) produces an in-session finding with screenshot.

### Session 4 — Discovery mode orchestrator

**Goal:** the full multi-persona, simulated-time run.

- `src/orchestrator/` — reads `sim.config.ts` + domain pack; expands org size × simulated weeks × session frequency into a sequential schedule of persona-sessions; per-session weighted goal draw from `goalWeightsByPersona`.
- Per-session isolation: a hard-stopped session (blocking bug) logs full trace and the batch continues.
- Hard run-level dollar ceiling: graceful shutdown — finish the in-flight write, mark the run `budget-stopped`, never corrupt state.
- Teardown sequence: config-declared cleanup hook per domain pack that wipes run-created staging data; runs even after budget-stop or crash (finally-style).
- Finding status reconciliation across runs: match new findings against prior runs' findings, tag `new | still-open | resolved`. Define the matching key now (recommend: finding type + normalized route + target identifier) and note it in BUILD-STATE.md.
- CLI entry: `drover run <domain-pack> [--config sim.config.ts]` via a minimal CLI lib (commander or similar).

**Done means:** a small config (2 personas × a few sessions) runs sequentially end-to-end via CLI, produces a populated SQLite run, survives one session being forcibly failed, and teardown executes.

### Session 5 — Analyst tier

**Goal:** cross-session pattern mining after a run completes.

- `src/analyst/` — loads a completed run's sessions/events/findings; builds per-session digests; sends to **Sonnet via the Batch API** (this is post-hoc — no streaming, no real-time path).
- Targets per CONTEXT.md: duplicate/repetitive labels, routes multiple personas independently stumble on, checkpoints technically reachable but abnormally slow, recurring dead ends. Output shape is a `cross_session_findings` row referencing a *set* of session IDs.
- Derived metrics computed here from raw timestamps (time-to-first-action, time-stuck) — computed, not stored as schema columns.
- Structured output contract with validation; malformed analyst output gets logged and skipped, never crashes the pipeline.
- CLI: `drover analyze <run-id>` (separate command so a run can be re-analyzed without re-simulating).
- Test with fixture session data + mocked batch responses; one real batch run against Session 4's output.

**Done means:** `drover analyze` on a real run writes cross-session findings with correct session references; batch polling handles the async Batch API lifecycle.

### Session 6 — Reporting

**Goal:** the markdown report — the core deliverable.

- `src/report/` — generates from SQLite (SQLite stays the source of truth; report is a projection).
- Structure per CONTEXT.md: findings summary table first (severity, type, session count, status), then breakdown by flow. Scannable, not chronological. Include run metadata (config dimensions, cost actuals vs. budget, sessions completed/hard-stopped/budget-capped).
- Cross-run status comparison via the status tags — a simple "since last run: N new, N still open, N resolved" block, no trend graphs.
- Findings link to their evidence (screenshot paths, event IDs) rather than inlining everything.
- CLI: `drover report <run-id> [--out report.md]`.
- Snapshot tests against fixture data.

**Done means:** a real run from Sessions 4–5 produces a readable report a human could act on; user should be shown a sample and asked for structure feedback before Session 7 (note this in BUILD-STATE.md as a pending user checkpoint — proceed regardless if no feedback by next session).

### Session 7 — Stampede mode

**Goal:** scripted, non-LLM load replay of discovered routes.

- `src/stampede/` — extracts successful route/checkpoint paths from a prior discovery run's event log; replays them as pure Playwright scripts (zero LLM calls) at configurable concurrency with ramp steps.
- Metrics: p50/p95/p99 response time per route, error rate, degradation as concurrency climbs. Stored in SQLite (own tables), reported via a Stampede section/report reusing Session 6's generator.
- Distinct CLI command: `drover stampede <run-id> --max-concurrency N [--ramp ...]`.
- Safety: refuses to run against any URL not explicitly listed as staging in the domain pack; concurrency hard cap in config; same teardown hook applies.

**Done means:** a Stampede run against staging (or a local test server if staging is unavailable — note in BUILD-STATE.md) produces percentile metrics and a report section.

### Session 8 — Domain packs, packaging, README

**Goal:** the open-source surface: examples, docs, and the real Horse Haven pack.

- Ship archetypes in `src/archetypes/`: impatient/rushed, first-timer/cautious, distracted, power-user-on-mobile.
- Example domain packs in `examples/`: (1) a toy generic app pack (self-contained — include a tiny local demo app it can run against, so adopters can try Drover with zero external setup), (2) the full Horse Haven Ops pack (`dataPolicy: "synthetic-only"`, real roles: volunteer check-in, coordinator adjusting feeding schedule, first-time visitor browsing horses). If Horse Haven goal/checkpoint details are unknown, draft them from the app's staging site and flag them for user review in BUILD-STATE.md.
- README: what Drover is, quickstart against the toy example, domain pack authoring guide (including the checkpoint detector DSL), **the Data Routing & Privacy section front-and-center** (per CONTEXT.md — adopters must make the `dataPolicy` call knowingly), model routing/cost table, Stampede usage, Phase 2 roadmap.
- LICENSE (MIT), CHANGELOG stub, `npm pack` sanity check, final lint/test pass.

**Done means:** a stranger could clone the repo, run the toy example end-to-end from the README alone, and author their own domain pack from the guide.

### Session 9 — Validation run + learning-loop pass

**Goal:** prove it on the real target and close the loop.

- Full discovery run against Horse Haven staging with the real domain pack (get staging URL/creds from the user if not already configured — this is the one session that cannot proceed without them).
- Then `analyze`, `report`, and a small Stampede run. Review output quality: are findings real and actionable? Is the reasoning capture useful? Did budgets behave?
- File everything learned: Drover shortcomings → `GAPS.md`; treeLine issues hit → `TREELINE-GAPS.md`; report the findings summary to the user.
- Fix only *harness-breaking* bugs found during validation in this session; quality improvements get logged in GAPS.md as post-v1 work.
- Mark the build `V1 COMPLETE` in BUILD-STATE.md with a summary of known gaps.

**Done means:** one real end-to-end run exists, its report has been shown to the user, and both gap files reflect what the run taught us.

---

## BUILD-STATE.md format (create in Session 1, maintain forever)

```markdown
# Drover Build State
Current session: <N> — <DONE | PARTIAL | BLOCKED>
Next step: <one imperative sentence a fresh model can act on immediately>

## Decisions log
- <date> S<N>: <decision> — <one-line rationale>   # only decisions CONTEXT.md didn't dictate

## Pending user input
- <anything waiting on the user, e.g. staging creds, report-format feedback>

## Session history
- S1 <date>: <status> — <one line of what landed>
```
