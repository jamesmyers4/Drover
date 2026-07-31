# Drover — CONTEXT.md

## What this is

Drover is an open-source, config-driven simulation harness that runs AI-driven personas through a web app over compressed simulated time, capturing what real users would run into — bugs, confusing flows, dead ends, duplicate or repetitive UI text, and (via its load-testing mode, **Stampede**) performance characteristics under volume. It's built to be pointed at any web app via a domain pack, with Horse Haven Ops (`volunteer.horsehaventn`) as the first real target and reference implementation.

The core idea: scripted tests catch the bugs you predicted. Drover is built to catch the ones you didn't, by simulating the messy, unscripted way real people actually use software — then handing you back a report instead of a pile of raw transcripts to read yourself.

Name origin: a drover moves a herd along a route over days, watching for strays and getting them all to the destination — which is close to literally what this tool does. The load-testing mode is named **Stampede**: same herd, moving fast, no reasoning, just volume.

## Non-goals for v1

Explicitly out of scope until the architecture is proven out:

- Autonomous code fixes or commits (fixer tier — see Phase 2)
- Multi-model quorum/approval voting for autonomous actions (Fixer-tier code-change approval) — narrowed 2026-07-30, see `docs/adr/0001-grader-quorum-exception.md`: **Grader** (a new, separate subsystem — not a fourth tier, see Glossary) uses model consensus as a distinct, allowed mechanism (grades text, never acts on a system)
- Auto-promotion of recurring findings into personas without human review
- Accessibility auditing (axe-core style) or visual/design-drift detection — separate composable modules for later, not part of the core actor loop
- Scheduled or CI-triggered runs (manual CLI only for now, architected so scheduling is a config addition later, not a rebuild)
- Domain packs as installable/publishable packages (local config files only)

## Relationship to treeLine

Drover depends on treeLine as a library rather than reimplementing its solved problems — specifically:

- Playwright `storageState` session re-seeding
- Auth-wall detection (two-mechanism detection already built)
- `resolveSeedUrl` and related crawl-target resolution

treeLine's crawl output is an **optional seed** for a persona's map of the app, config-switchable per persona:

- Personas with `familiarity: returning` or `veteran` can be seeded with treeLine's known route map (they've "used the app before")
- Personas with `familiarity: new` explore cold, with no map — simulating a first-time volunteer who's never seen the site

Feedback flows back to treeLine explicitly: any run that hits a treeLine limitation (an auth pattern it doesn't handle, a crawl gap, a session-seeding edge case) gets logged live to `TREELINE-GAPS.md` in this repo. Periodically, entries get turned into actual treeLine issues or session briefs — same workflow as `TREELINE-BUILDOUT-SESSION.md`. This is a real, working feedback loop, not a someday-maybe intention.

## Architecture: three tiers

**Actor tier** — individual persona agents that actually drive the browser. High call volume, low stakes per call (what to click, is this label confusing). Model: cheap/swappable, see Model Routing & Cost below. Logs structured telemetry as it goes: every action, raw timestamps, a one-sentence reasoning annotation per action.

**Analyst tier** — sits above all actor-tier session data after a run completes, mining across sessions for patterns no single actor would notice mid-session: repetitive dead-end labels, duplicate routes, findings that recur across many personas or many runs. Model: Sonnet, run via Batch API since this is post-hoc, non-real-time analysis.

**Fixer tier (Phase 2, not v1)** — proposes code fixes for confirmed findings, opens a PR for review. Never auto-commits to main. When this lands, multi-model quorum (N-of-M independent models must agree before a fix gets proposed, with a "share reasoning and reassess" round on disagreement, escalating to human review if they still can't converge) arrives alongside it — not before, so v1 stays single-model per tier while the core simulation concept gets validated.

## Execution modes

**Discovery mode** — the core mode. Weighted-goal personas run through the app across simulated time (configurable org size × simulated duration in weeks × session frequency), one persona-session at a time, sequential rather than parallel (chosen deliberately over heavy concurrency — fewer confounding issues than a lot of parallel LLM-driven browser sessions competing for a dev-tier staging server, and cost/behavior easier to reason about).

**Stampede mode** — a distinct CLI command. Takes the actual routes/checkpoints discovery mode already found and replays them as scripted (non-LLM, no reasoning) Playwright sessions at volume — same underlying harness, different runner. Captures response time percentiles (p50/p95/p99) per route, error rate under load, and how those numbers degrade as concurrency climbs. This is genuinely useful for Horse Haven Ops specifically right now, since it's still dev-stage and its real breaking point isn't known yet.

A GitHub Actions run trigger is a documented future option for both modes (scheduled discovery, scheduled load tests) — not built for v1, since manual/on-demand fits how this will actually get used at first.

## Persona & domain pack schema

Two layers, deliberately split so the tool is reusable beyond Horse Haven Ops:

**Generic persona/archetype layer** (ships with the tool, applies to any app):

```typescript
interface PersonaArchetype {
  id: string;
  name: string;
  traits: {
    patience: number;
    techSavviness: number;
    deviceType: "mobile" | "desktop" | "tablet";
    familiarity: "new" | "returning" | "veteran";
  };
}

interface WeightedGoal {
  goalId: string;
  weight: number;
}
```

A small core archetype set ships with the tool itself: impatient/rushed, first-timer/cautious, distracted, power-user-on-mobile. This is the actual open-source value — someone adopting Drover for a different app reuses these archetypes and only has to write their own domain pack.

**App-specific domain pack layer** (local config file per target app, e.g. Horse Haven's real roles: volunteer checking in, coordinator adjusting a feeding schedule, first-time visitor browsing horses):

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
  detector: string;
}

interface DomainPack {
  appName: string;
  personas: PersonaArchetype[];
  goals: Goal[];
  goalWeightsByPersona: Record<string, WeightedGoal[]>;
  dataPolicy: "synthetic-only" | "restricted";
}
```

Each persona draws from a **weighted goal pool** per run rather than one fixed goal — this is what turns Drover from "can someone complete this one flow" into "what do real users actually do, in what proportions," which is closer to the original sped-up user-experience-simulation framing than a single-path test would be.

Success/checkpoint definitions live in the domain pack, not the generic layer, since what "done" means is inherently app-specific — modeled the same way Playwright POM element IDs map to test steps.

## Data capture & storage

SQLite, kept completely separate from any target app's own database (Horse Haven Ops' Neon DB, etc.) — keeps the tool portable for other adopters, nobody should need to stand up Postgres just to run a QA simulation.

**Event log** — every actor action gets logged, not just checkpoint hits:

```typescript
interface ActionEvent {
  sessionId: string;
  timestamp: number;
  actionType: string;
  target: string;
  reasoning: string;
  checkpointId?: string;
}
```

Raw timestamps only — derived metrics (time-to-first-action, wait-vs-thinking time, time stuck) get computed after the fact rather than locked into the schema now. Same "log raw, compute later" principle as treeLine's opt-in response-body capture.

**Findings — two separate tables, not one:**

- `in_session_findings` — caught live by the actor (console error, HTTP 500, a checkpoint never reached within the goal's action budget). References a single event.
- `cross_session_findings` — only visible after the analyst tier has chewed through multiple sessions (duplicate labels, a route several personas independently stumble on, a checkpoint that's technically reachable but takes far longer than it should). References a set of sessions.

Each finding carries a status tag across runs: `new | still-open | resolved`. Because status history is already tracked per finding, "how many runs has this been open" is just a count on existing data — the future auto-promotion-after-N-occurrences rule (see Learning Loop) doesn't require new instrumentation, just a threshold check.

**Reasoning capture** — one short "why I did this" annotation per action, not full chain-of-thought. Enough to understand a weird decision later without paying to store/re-read full reasoning traces at volume.

**Visual evidence** — no screenshots or traces on every action. A screenshot + short trace snippet gets pulled only at the moment a finding (in-session or cross-session) gets flagged. Keeps the raw event log lightweight; expensive artifacts exist exactly where you'd actually want to look at them.

## Environment & safety

- Runs against a live staging deployment (current dev-stage server), never production
- Staging data is synthetic/seeded only — enforced by a final teardown sequence that wipes everything the run created before the next one starts
- Per-session isolation: one persona hitting a blocking bug halts only that session (logged as a hard-stop with full trace), the rest of the batch continues — a blocked session is itself valuable data, not a run-ending failure
- Sequential execution by default, conservative configurable concurrency cap available but not the default — protects a dev-tier server from the simulation itself becoming the source of noise in the findings. As built, `runDiscovery` supports both: unset/1 runs sequentially, and a `concurrencyCap` above 1 runs a real bounded worker pool (see `CLAUDE.md`) — with one trade-off worth knowing before raising it: the run-level budget ceiling is exact only at `concurrencyCap` 1, since above that other sessions can already be in flight by the time the ceiling is noticed.

## Reporting

- Markdown report as the core deliverable, structured JSON/SQLite underneath as the source of truth (so a dashboard is an additive feature later, not a rebuild)
- Report-only in v1 — no auto-filed GitHub issues. Promoting a finding to an actual issue is a manual action you trigger, consistent with the zero-write-access governance principle applied everywhere else in this design
- Structure: findings summary table first (severity, type, session count), then breakdown by flow — same shape as `GPB-QA-Concerns-V1.md`, scannable rather than chronological
- Cross-run comparison via the simple status tag (new/still-open/resolved), not full trend graphing for v1

## Model routing & cost

| Tier            | Model                           | Mode                  | Notes                                               |
| --------------- | ------------------------------- | --------------------- | --------------------------------------------------- |
| Actor           | Cheap/swappable (default Haiku) | Real-time             | Provider is a config choice, see Data Routing below |
| Analyst         | Sonnet                          | Batch API (50% off)   | Post-hoc analysis, no latency requirement           |
| Fixer (Phase 2) | Multiple models, quorum         | Batch/real-time mixed | Not built until Phase 2                             |

- Two separate budget knobs per run: a hard dollar ceiling for the whole run (fails gracefully, doesn't just die mid-write), plus a soft per-persona-session cap so one runaway persona can't consume the whole budget alone
- Prompt caching for each persona's shared static context (domain pack, archetype definition, app's checkpoint schema) — cached once per session rather than resent with every action

## Data routing & privacy (read before enabling non-Anthropic providers)

Actor-tier model choice is an explicit, per-domain-pack config decision (`dataPolicy` field), never a silent default:

- **`synthetic-only` domain packs** (Horse Haven Ops and similar): cheap third-party providers (including non-US providers) are an acceptable actor-tier choice, since staging data is synthetic and no real person's information is at risk even if a provider trains on or retains the traffic. Auth tokens, session cookies, and API keys never ride along in prompt content regardless of provider — they stay in the orchestrator's HTTP layer only.
- **`restricted` domain packs** (any app processing real personal, legal, medical, or otherwise sensitive content — e.g. Shenny): actor tier stays on Anthropic or another provider with clear contractual data handling. No exceptions for cost savings. A fully local model (via Ollama) is the zero-exposure alternative if cost is still a concern for a restricted-policy app.
- This section is front-and-center in the README for anyone else adopting Drover — their app's sensitivity may look nothing like Horse Haven Ops', and they need to make that call knowingly.

## Learning loop

- `GAPS.md` — Drover's own blind spots and future improvements, logged as they're found during real runs
- `TREELINE-GAPS.md` — treeLine-specific limitations surfaced during runs, kept separate so the two feedback loops don't tangle, periodically converted into treeLine issues/session briefs
- Recurring findings are promoted into personas/domain packs **manually** in v1 — a human decides what's worth baking into permanent scenario coverage, not an automatic process
- Future (not v1): an auto-promotion rule once a finding's open-run count crosses a configurable threshold — deferred because the data needed for it (status history per finding) is already being captured, so this is a rule to add later, not new instrumentation to design now
- Explicitly not "fine-tuning" in the literal model-weight sense — Anthropic doesn't offer public fine-tuning at individual-developer scale. What actually improves over time: prompts, personas, detection rules, and the domain pack itself, sharpened by real captured findings. Same mechanism treeLine already uses.

## Open source packaging

- Config format: typed TypeScript (`sim.config.ts`), not JSON/YAML — matches the stack, gives autocomplete against the persona/domain-pack schema, catches shape errors at compile time
- Repo ships 2–3 example domain packs: a toy/generic example app plus the real Horse Haven pack as a full reference implementation — the single biggest adoption lever, since a working example to fork beats an empty schema to author from scratch
- License: MIT
- Domain packs are local config files for v1, not an installable/publishable package system — added later only if a real cross-repo sharing need shows up
- Single package repo structure for v1, no monorepo — matches how treeLine and OPENEMR-QA are already separate repos rather than one combined structure

## Phase summary

**Phase 1 (v1):** actor + analyst tiers, discovery mode, Stampede load mode, manual CLI trigger, single package, SQLite, markdown reporting, `GAPS.md` + `TREELINE-GAPS.md`, synthetic-data-only staging, sequential execution, manual finding promotion, TS config + example domain packs, MIT license.

**Phase 2 (future):** fixer tier (PR-opening, human-merged), multi-model quorum for fixer approvals, auto-promotion of recurring findings past a configurable threshold, GitHub Actions scheduling for discovery/Stampede, accessibility and visual-drift agents as separate composable modules, domain packs as installable packages if real demand shows up.

## Glossary

- **Actor** — a single persona agent driving a browser session
- **Analyst** — the cross-session pattern-finding tier, runs after a batch completes
- **Fixer** — Phase 2 code-fix proposal tier
- **Domain pack** — app-specific config: personas, goals, checkpoints, data policy
- **Archetype** — a generic, reusable persona trait template
- **Checkpoint** — a defined state within a goal, used to measure progress and success
- **Discovery mode** — LLM-reasoning personas exploring and finding issues
- **Stampede** — scripted, non-reasoning replay of discovered routes at load-testing volume
- **Quorum** — Phase 2 multi-model agreement requirement before a fix is proposed

### Grader

A separate subsystem (not a fourth tier — see below), added 2026-07-30/31. Full resolution history in `docs/adr/0001`–`0005`.

- **Grader** — scores arbitrary AI-generated output from a target app against a rubric, using single- or multi-model consensus. Runs standalone via its own CLI entry point (`drover grade`); does not participate in the actor/analyst/fixer `runs`/`sessions`/`action_events` lineage. Operates as a pure function over `{input, output, rubric}` triples — it never invokes a target app's AI feature to generate output itself; producing that triple (via a live API call, a data export, or a fixture) is entirely the adapter's responsibility. This is a scope boundary, not a performance/timing constraint — an adapter is free to generate and grade back-to-back in one CI step; the rule is only that Grader's own code never contains generation-invocation logic. See `docs/adr/0001-grader-quorum-exception.md`.
  _Avoid_: Judge / Judging engine (collides with "LLM-as-judge," the technique it uses internally)
- **GraderPack** — app-specific adapter for Grader: named rubrics, a `loadCases` supply function, optional per-layer config, and its own `dataPolicy`. Deliberately *not* a straight port of `DomainPack.dataPolicy` semantics — see `docs/adr/0002-grader-datapolicy-fail-closed-escalation.md`: `restricted` means local-only, full stop; a separate `allowHostedEscalation` flag (default `false`, fail-closed) is required before any Task may dispatch to a hosted judge, checked per-dispatch since Consensus Round escalation happens dynamically mid-run.
- **Grading Run** — one top-level invocation of Grader against a GraderPack-supplied dataset. Its own entity, no relation to Drover's `Run`/`runs` table.
- **Case** — one `{input, output, rubric}` triple supplied by the adapter; the thing Grader ultimately produces a verdict for. `rubric` is a **reference** (a name/key into the GraderPack's rubric lookup table), not an inline object — a pack typically services several distinct AI features in the target app, each with its own named rubric, and different Cases in one batch reference different rubrics accordingly. The name is resolved to live rubric content at Task-dispatch time, but the **resolved content (or a content hash) is snapshotted onto the Task's persisted result** — not just the name — so a Grading Run's results stay interpretable even if the pack's rubric definitions change later. Not every layer consumes `rubric` at all (Layer 1's deterministic checks and drift/baseline-comparison layers don't use named criteria).
- **Task** — the dispatch/execution unit: "run layer *L* against Case *C*" (or, within a Consensus Round, "get judge *J*'s vote on Case *C*'s layer *L*"). A Task is **not** intrinsically an LLM call — a deterministic-checks-layer Task is plain synchronous code with no context to manage; an LLM-judge-layer Task is the one with the fresh-context/discard-after-one-shot property from the fresh-context architecture. The scheduler's dispatch contract must not assume uniform execution cost across Tasks. A Task's outcome is one of three first-class states — pass, fail, or **skipped** (an unmet declared prerequisite) — never conflated with pass/fail, since a report showing "8/9 passed, 1 skipped" is a materially different claim than "8/9 passed." An LLM-backed Task's result also records `executionTarget` (which physical box/endpoint ran it) as a **field distinct from `modelFamily`** — the former is a placement/scheduling property, the latter a diversity property (see `docs/adr/0003-consensus-diversity-is-structural.md`); conflating them would silently reintroduce the coincidental-diversity problem that ADR resolved, since placement can change (box reprovisioned for capacity) independent of what model actually ran.
  _Avoid_: assuming every Task spins up a model — only LLM-backed layers do; treating "skipped" as a fail or omitting it from a report's totals
- **Check** — a single named, independently-scored criterion living *inside* one Task's structured result payload (e.g. one rubric criterion's score). Not its own dispatch unit — one Task/one LLM call can score several Checks in a single pass, since loading the Case's input/output is the expensive part, not asking one question vs. several. A Check's definition (in the rubric) carries its own agreement rule alongside its name/scoring type — e.g. exact-match for a boolean Check, a numeric tolerance for a scored one — since tolerance is meaningless or wrong applied uniformly across different Check data types. A judge Task's result persists **reasoning alongside each Check's score**, not the score alone, so a later escalation Task has enough basis to actually adjudicate a disputed Check rather than just average or pick between two unexplained numbers.
- **Screener** — a small, cheap local model used for a fast first-pass signal. **Not a dispatch gate** — screening is an ordinary always-run layer/Check whose result is used for report sorting and human-attention triage only. It never decides whether a downstream layer runs; that authority belongs solely to the prerequisite-declaration mechanism (see Task entry above), which exists specifically so cost-flavored "feels pointless to check further" intuition can't quietly erode the always-run-everything default under a friendlier name.
- **Consensus Round** — the set of Tasks belonging to one multi-judge layer on one Case, plus resolution. Resolution is **per-Check, not holistic**: each Check where all judges agree (per that Check's own agreement rule) settles immediately; each Check where they don't gets its own scoped escalation Task ("resolve Check *C* on Case *X*," given the disputing judges' scores *and* reasoning, not just verdicts). A Round's layer-level result reports every Check's final verdict plus how many needed escalation (e.g. "4/5 agreed, 1/5 escalated") — never collapsed into one opaque pass/fail. Consequence: a Round fans out to a **variable number of scoped Tasks (0 to N, N = Check count)**, not a fixed width — still pure bookkeeping for the scheduler, but a real fan-out shape to design for up front rather than discover mid-implementation. Model-family diversity across a round's *initial* judge Tasks is a structural invariant checked at dispatch/resolution time (each Task result carries a `modelFamily` field — family-level identity, so two quantizations of the same base model count as one), not an assumption inferred from which physical machine happened to run which judge — see `docs/adr/0003-consensus-diversity-is-structural.md`.
- **Grading report** — Grader's own markdown deliverable (`drover grade`'s human-facing artifact), a distinct file from the CI JSON summary (`docs/adr/0005-grader-ci-wiring.md`) — different audiences with different stability needs, so improving the report's detail/framing over time is never a breaking change to a consuming repo's CI parser. Must render `skipped` as its own visual category, never absorbed into "not a pass." Surfaces Cases ranked by escalation count first, skip count second, as its triage ordering — a Case with zero escalations needed no human judgment to resolve cleanly, one with several is exactly where local judges genuinely disagreed. Embeds each Case's resolved rubric — both a content hash and the human-readable criteria text inline, not a bare name reference — so the report stays self-contained and interpretable even months after the GraderPack's rubric definitions have changed (the presentation-layer counterpart to the Case entry's snapshot-at-persistence fix).

## Open questions (not yet resolved, revisit before Phase 2)

- Exact threshold/formula for auto-promoting a recurring finding into permanent persona/domain-pack coverage
- Whether Stampede's load metrics eventually feed back into discovery-mode persona "patience" tuning (a route that's slow under load might also feel slow to a real, unhurried persona)
- Dashboard vs. markdown-only, once/if a second consumer of the underlying SQLite data shows up beyond the CLI report
- **Grader's Layer 8 (drift/production monitoring) is deferred, not v1 scope.** It doesn't fit the Case type signature (`{input, output, rubric}`) locked in for v1 — a baseline comparison needs a second input (which prior point? most recent run? a pinned reference? a rolling window?) that's a genuine design question, not a schema gap to paper over. It's also not independently schedulable: it depends on `grader.sqlite` actually having accumulated a real history of completed Grading Runs to compare against, which only exists once v1 has been running for a while — don't pick this up as "next sprint" work before that history exists. When it is designed, check whether today's Task/Case schema needs a migration to make "find this Case's prior results" a tractable query, rather than discovering that need in hindsight after months of accumulated data.
