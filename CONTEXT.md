# Drover — CONTEXT.md

## What this is

Drover is an open-source, config-driven simulation harness that runs AI-driven personas through a web app over compressed simulated time, capturing what real users would run into — bugs, confusing flows, dead ends, duplicate or repetitive UI text, and (via its load-testing mode, **Stampede**) performance characteristics under volume. It's built to be pointed at any web app via a domain pack, with Horse Haven Ops (`volunteer.horsehaventn`) as the first real target and reference implementation.

The core idea: scripted tests catch the bugs you predicted. Drover is built to catch the ones you didn't, by simulating the messy, unscripted way real people actually use software — then handing you back a report instead of a pile of raw transcripts to read yourself.

Name origin: a drover moves a herd along a route over days, watching for strays and getting them all to the destination — which is close to literally what this tool does. The load-testing mode is named **Stampede**: same herd, moving fast, no reasoning, just volume.

## Non-goals for v1

Explicitly out of scope until the architecture is proven out:

- Autonomous code fixes or commits (fixer tier — see Phase 2)
- Multi-model quorum/approval voting
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
- Sequential execution by default, conservative configurable concurrency cap available but not the default — protects a dev-tier server from the simulation itself becoming the source of noise in the findings. As built, only the sequential path is implemented; `runDiscovery` rejects a `concurrencyCap` above 1 with a clear error rather than silently ignoring it, until real bounded concurrency exists (see `CLAUDE.md`).

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

## Open questions (not yet resolved, revisit before Phase 2)

- Exact threshold/formula for auto-promoting a recurring finding into permanent persona/domain-pack coverage
- Whether Stampede's load metrics eventually feed back into discovery-mode persona "patience" tuning (a route that's slow under load might also feel slow to a real, unhurried persona)
- Dashboard vs. markdown-only, once/if a second consumer of the underlying SQLite data shows up beyond the CLI report
