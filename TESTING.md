# Drover Testing Buildout — plan & tracker

This file is the plan *and* the running tracker for bringing Drover's test
infrastructure up to the same maturity treeLine's reached (see "What treeLine
had" below, adapted from that repo's now-deleted `TESTING-treeLine.md`, which
this file replaces). Read `CLAUDE.md` and `CONTEXT.md` first, same as any
other work in this repo — this file assumes the constraints and module map
those two already establish and doesn't repeat them.

**How to use this file:** it's broken into sessions, one per Claude Code
run, the same pattern `BUILD-STATE.md` uses for feature work. Each session:
read this file, do the "Next step" session's work (and only that session —
don't start the next one early), update the "Current session / Next step"
line and add a dated entry under "Decisions log" for anything non-obvious
that came up, then stop. The user reviews and commits manually between
sessions and restarts Claude Code for the next one.

**Current session: 1 — CI workflow (workflow added, awaiting a real push/PR
to confirm it passes in the Actions tab before Session 2 starts — see
decisions log)**
**Next step:** Push (or open a PR) so the workflow actually runs on GitHub,
confirm it's green, then start Session 2. Do not start Session 2 before
that confirmation lands.

---

## Baseline: what already exists (no session needed)

Unlike treeLine at the point its own testing buildout started, Drover
already has a real unit/integration test layer — this isn't a from-scratch
effort, it's closing two specific gaps on top of an existing foundation:

- 19 test files under `tests/`, ~110+ tests (exact count drifts — trust
  `npm test`'s own summary over any number written here), run via `vitest
  run`. Real coverage, not placeholder: `tests/fixtures/site.ts` is a local
  `node:http` fixture server (nav, form, login, console-error page, 500
  endpoint) that browser-driven tests launch real Playwright chromium
  against — same "real browser, real local server, no mocked Playwright"
  posture treeLine's unit layer has. `ScriptedModelProvider` /
  `ScriptedAnalystProvider` stand in for the real Anthropic SDK in loop/
  orchestrator/analyst tests so those suites run with no API key and no
  network dependency; `tests/actor/provider.test.ts` and
  `tests/analyst/provider.test.ts` separately mock the `@anthropic-ai/sdk`
  module itself to cover the real-provider code paths (request shaping,
  cost computation, malformed-output handling) without live calls.
- `npm run typecheck`, `npm run build`, `npm run lint` (Biome) all pass
  clean today per `CLAUDE.md`'s working conventions — this buildout must
  not regress that.
- Three real-model smoke scripts (`smoke:actor`, `smoke:orchestrator`,
  `smoke:analyst`) already exist and already play the role treeLine's
  `packages/verify` played: manual, on-demand, needs a live credential
  (`ANTHROPIC_API_KEY`), not CI-gated, and never will be — see "No verify
  analog" below. Nothing to build here, just noting the parallel.

What's actually missing, and what this file's sessions close:

1. **No CI** — nothing runs `npm test`/`typecheck`/`lint` automatically on
   push or PR. Every check today is manual.
2. **No golden-master / full-pipeline layer** — every existing test proves
   an individual module's behavior in isolation (a checkpoint detector, a
   budget calculation, one orchestrator scenario at a time). Nothing proves
   the *whole* `drover run` → SQLite → `drover analyze` pipeline produces
   stable, correct end-to-end output the way a unit test can't by
   construction — the same gap treeLine's `packages/cli/test/` golden files
   closed for its crawl pipeline.

---

## What treeLine had, and how Drover's plan differs

treeLine's testing buildout (documented in the file this one replaces) had
three layers: per-package unit/fixture tests, a golden-master pipeline
layer, and `packages/verify` (a manual live-target verification tool). The
plan below adapts the first two; the third has no analog here, on purpose:

- **Unit/fixture tests** — already done in Drover (see Baseline above). No
  session needed; Session 2 below only *audits* this layer against
  `CLAUDE.md`'s non-negotiable constraints rather than rebuilding it.
- **Golden-master pipeline tests** — the real gap, Session 3 below.
  Adapted, not copied: treeLine's golden output is generated *code*
  (Playwright POMs/specs) and *markdown reports*, so it had to exclude
  `test/golden/**` from vitest's own test-file glob to stop it importing
  `@playwright/test` inside a checked-in spec fixture. Drover has no
  code-generation output — a full pipeline run produces SQLite rows and an
  optional screenshot, not source files — so that specific gotcha doesn't
  apply here. What *does* carry over directly: normalizing nondeterministic
  values (UUIDs, wall-clock timestamps, ephemeral fixture-server ports)
  before comparing against a checked-in golden file, and the
  `UPDATE_GOLDEN=1`-to-regenerate convention.
- **No `packages/verify` analog** — treeLine's `verify` tool existed to
  answer one specific question against a real, live authenticated target:
  "does this nav link's real destination match what the crawl recorded?"
  Drover has no equivalent artifact needing that kind of external
  verification — its analogous "does this behave correctly against a real
  model" question is already answered by the three existing smoke scripts.
  Nothing to build; not a session below. If a real Horse Haven Ops run (S9
  in `BUILD-STATE.md`'s numbering) later surfaces a class of question that
  genuinely needs live/manual verification the smoke scripts don't cover,
  log it in `GAPS.md` when it happens rather than speculating about it now.
- **CI** — treeLine's CI needed Xvfb because `launchHardened` hardcodes
  `headless: false` with no test-time override. Drover's
  `launchBrowser()` (`src/browser/session.ts`) defaults `headless: true`
  (`chromium.launch({ headless: options?.headless ?? true })`), and no
  Drover test overrides it — confirmed by reading the code before writing
  this, not assumed. **No Xvfb needed in Drover's CI.** Still needs a
  `playwright install` step for the chromium binary itself, and Session 1
  should confirm (not assume) that `better-sqlite3@^12.11.1`'s prebuilt
  binary installs cleanly on the CI runner's OS/Node combination, same
  "verify, don't assume" discipline treeLine's own CI session used for its
  Xvfb requirement.

---

## Session 1 — CI workflow

**Goal:** every push and PR to `main` runs the same checks `CLAUDE.md`
already requires locally, automatically.

- Add `.github/workflows/test.yml`: triggers on `push`/`pull_request`
  targeting `main`. Steps: checkout, setup Node 20 (match `engines.node` in
  `package.json`), `npm ci`, install the Playwright chromium binary (`npx
  playwright install --with-deps chromium` — confirm whether `--with-deps`
  is actually needed on the chosen runner OS for headless-only use, don't
  just paste it reflexively), then run `npm run typecheck`, `npm run
  build`, `npm run lint`, `npm test` — fail the job on any non-zero exit.
- No `ANTHROPIC_API_KEY` in CI — this is expected and correct. Every
  existing test that would need one either uses `ScriptedModelProvider`/
  `ScriptedAnalystProvider` or mocks the SDK module directly (see
  Baseline). Confirm `npm test` is fully green with no `ANTHROPIC_API_KEY`
  env var set in the CI environment (it already should be — verify, since
  a real key happening to be present in some other check locally could be
  masking an accidental live-call dependency).
- Confirm `better-sqlite3`'s prebuilt binary actually installs on the
  runner (`ubuntu-latest` is the natural default — cheapest, matches most
  GitHub Actions precedent). If it doesn't, that's a real finding to
  surface, not a reason to silently switch to building from source.
- Keep it to one workflow file, no caching/matrix complexity yet — a
  `actions/setup-node`'s built-in `cache: npm` is fine and cheap to add,
  but don't build out a Playwright-browser cache step or an OS/Node matrix
  unless something above actually requires it. This is v1 CI, matching
  `CLAUDE.md`'s "Phase 1 scope only" discipline applied to test tooling
  too — a matrix build is exactly the kind of scope creep to log in
  `GAPS.md` instead of building preemptively.
- **Done means:** a real PR (or push, if the user prefers to just watch it
  run on `main`) shows the workflow executing and passing in the Actions
  tab. Update this file's "Current session / Next step" to point at
  Session 2 and add a decisions-log entry below with the runner OS chosen
  and whatever the `better-sqlite3`/`--with-deps` findings actually were.

## Session 2 — Constraint-coverage audit

**Goal:** confirm every one of `CLAUDE.md`'s "Non-negotiable constraints"
has an explicit, findable test asserting it — not a rebuild of the unit
layer, an audit of it, closing real gaps only where they're actually found.

Go through `CLAUDE.md`'s constraint list one at a time and locate (or, if
genuinely missing, write) the test that proves each one. Do not add
speculative coverage beyond this list — this is a gap-closing pass, not a
general coverage-expansion exercise:

- Sequential-only execution / `concurrencyCap > 1` rejection
  (`ConcurrencyNotImplementedError`, checked before the run row is
  written) — likely already covered in `tests/orchestrator/run-discovery.
  test.ts`; confirm the assertion checks it fires *before* `db.insertRun`
  runs (order matters per `CLAUDE.md`), not just that it throws at all.
- `restricted` dataPolicy refusing a non-`anthropic` provider
  (`assertDataPolicyAllowed`).
- `fill()` primitive values never entering the event log (only the
  selector) — confirm there's a test asserting the *value* itself is
  absent from a logged event, not just that the selector is present.
- Run-level hard dollar ceiling checked *between* sessions, never
  mid-session, and never dying mid-write.
- Per-persona-session soft budget cap ending a session `budget-capped`.
- Analyst `analystCeilingUsd` pre-flight estimate throwing *before*
  `provider.analyze()` is ever called (i.e. confirm the test asserts the
  provider was never invoked, not just that the error was thrown).
- Malformed `decide_action` cost still recorded against budget.
- Two-phase reconciliation's `crossSessionDataComplete` flag behavior.
- Reasoning capture is one sentence per action, not multi-field
  chain-of-thought (schema-level — confirm the structured decision output
  type actually constrains this, or note in `GAPS.md` if it's
  convention-only and unenforced).
- Screenshots/traces captured only at finding-flag time, never per-action.
- Secrets (auth tokens, cookies, API keys) never entering prompt content —
  this one may be harder to point at a single existing test; if so, that's
  a real finding, not a reason to skip it. Note where it's structurally
  true (secrets live in `BrowserSession`'s Playwright layer, never passed
  into `src/actor/prompt.ts`'s builders) if no direct test exists, and
  decide with the user whether a regression test is worth adding here or
  just worth logging as a documented structural guarantee.
- CHECK-constraint-enforced enums (run/session status, finding types) —
  confirm at least one test per table exercises the DB actually rejecting
  an invalid value, not just that valid values round-trip.
- Domain-pack `teardown` runs finally-style even after a crash.
- Zero write access beyond what personas do through the target app's own
  UI (structural — likely nothing to test directly, but confirm there's
  no code path that would need a test here).

For each item: if a test already covers it, just note that (this file's
decisions log, not new test code) — treeLine's own "Step 0: confirm this
is necessary, don't assume" discipline applies to *finding* coverage too,
not just adding it. Only write new tests for genuine gaps.

**Done means:** the list above has a one-line disposition for each item
(covered by `<file>:<test name>` / gap closed with a new test / logged to
`GAPS.md` as a documented-not-tested structural guarantee), recorded in
this file's decisions log. `npm test` still green. Update "Current
session / Next step" to Session 3.

## Session 3 — Golden-master pipeline layer

**Goal:** lock down full-pipeline behavior (CLI or direct `runDiscovery`/
`runAnalyst` calls, real fixture browser, scripted model providers) against
checked-in golden output, so a future change that silently alters real
end-to-end behavior fails a test even though every individual unit test
still passes in isolation — the specific class of regression unit tests
can't catch by construction (same rationale treeLine's own golden-master
session gave).

- New `tests/golden/` directory. Shared `tests/golden/normalize-golden.ts`
  helper — strip/replace known-nondeterministic values before comparison:
  UUIDs (run id, session id, event ids, match keys are deterministic *given*
  fixed inputs but ids themselves aren't), wall-clock timestamps, and the
  fixture server's ephemeral port (`tests/fixtures/site.ts` binds
  `listen(0, ...)`, so it changes every run — confirm this the same way
  treeLine's own session did before assuming it, per that file's own
  account of finding this the hard way). Costs are *not* on the
  nondeterministic list — `ScriptedModelProvider`/`ScriptedAnalystProvider`
  use a fixed `costPerCallUsd`, so total cost across a locked scenario
  should be exactly reproducible; if a golden run's cost isn't stable
  across two consecutive runs, that's a real bug to fix, not something to
  normalize away.
- 2–3 locked scenarios, each driven directly through `runDiscovery`
  (reusing the pattern already established in
  `tests/orchestrator/run-discovery.test.ts`, not spawning a CLI
  subprocess — simpler, no process-spawn flakiness, and the CLI layer
  itself is thin enough not to need its own golden coverage). Suggested
  scenarios, matching what `CLAUDE.md`'s module map says the orchestrator
  actually has to get right:
  - **Clean run** — small org size, all sessions reach their checkpoint
    successfully, no findings, `completed` status, straightforward
    reconciliation.
  - **Mixed outcomes** — one persona hard-stops, one hits an in-session
    finding (console error or the fixture's 500 endpoint), one succeeds —
    proves per-session isolation and the batch continuing.
  - **Budget-stopped** — a run ceiling low enough that the schedule gets
    cut short, asserting `budget-stopped` status and that teardown still
    ran.
  - A 4th scenario covering `drover analyze`'s cross-session output (using
    `ScriptedAnalystProvider`) is worth adding once Session 6's reporting
    work lands and there's real report output to lock down too — don't
    build that scenario now if it'd just be locking down raw
    `cross_session_findings` rows with no report consumer yet; note this
    explicitly as deferred rather than silently skipping it.
- What each scenario compares: a normalized dump of the run's key rows
  (run status/cost totals, session statuses, finding types + routes,
  reconciliation status tags) — not a raw SQLite binary diff. Write a small
  `tests/golden/dump-run.ts` helper that reads the relevant `DroverDb`
  getters and produces stable, sorted, normalized JSON or text for
  comparison, since row insertion order and raw ids aren't meaningful
  signal here.
- `UPDATE_GOLDEN=1 npm test` (or a scoped `vitest run tests/golden`)
  regenerates the checked-in golden files — same convention treeLine used.
  Confirm this actually works by deliberately corrupting a golden file and
  confirming a real, readable diff on failure (not a silent pass), then
  restoring it — same verification discipline treeLine's own session
  applied, don't just assert this works by construction.
- Confirm `biome.json`'s `files.includes` already covers `tests/golden/**`
  (it should, since it's under `tests/**` — confirm, don't assume, given
  `CLAUDE.md` already flags this exact class of miss as "a real bug once
  already" for `scripts/**`).

**Done means:** `npm test` runs the golden scenarios automatically as part
of the normal suite (no separate script needed), all passing; the
corrupt-then-restore check above was actually performed once, not assumed;
`tsc`/`biome check` still clean. Update "Current session / Next step" to
Session 4.

## Session 4 — Wire into CI, close the loop

**Goal:** make sure Sessions 1–3's work is actually connected, and leave
this file itself accurate for whoever reads it next — same "the file
that could go stale" caution treeLine's own `TESTING.md` opened with.

- Confirm the golden-master tests from Session 3 run as part of the same
  `npm test` Session 1's CI workflow already calls (no new CI step should
  be needed if Session 3 didn't create a separate script — verify this,
  don't assume it just because it's under `tests/`).
- Add a one-line CI status badge to `README.md` if the user wants one (ask
  rather than assuming — it's a small, visible, easily-reverted change,
  not one to make unprompted).
- Rewrite this file's top section (everything above "Session 1") into a
  short **status snapshot** instead of a forward-looking plan, matching
  what treeLine's own `TESTING.md` looked like once its buildout finished:
  what layers exist, current test/file counts (pulled from a real `npm
  test` run at the time of writing, not estimated), how to reproduce
  locally, and what's still deliberately out of scope (the "no verify
  analog" reasoning from this version is still correct and should carry
  forward). Keep the per-session sections below as a historical record
  (matching `BUILD-STATE.md`'s own "Session history" convention) rather
  than deleting them.
- Log any real residual gaps found along the way to `GAPS.md`, not into
  this file — per `CLAUDE.md`'s existing convention, this file documents
  test infrastructure, `GAPS.md` documents product/behavior gaps.

**Done means:** this file reads as an accurate snapshot of a working,
CI-gated, three-session-old test suite, not a stale plan. `BUILD-STATE.md`
untouched by this work (testing infra and feature build sessions are
tracked separately, on purpose).

---

## Decisions log

**2026-07-24 (Session 1 — CI workflow)** — Added `.github/workflows/test.yml`:
`ubuntu-latest`, Node 20 (matches `engines.node`), `actions/setup-node`'s
built-in `cache: npm`, `npm ci`, `npx playwright install --with-deps
chromium`, then `typecheck`/`build`/`lint`/`test`, triggered on `push`/
`pull_request` to `main`. Findings from local verification before writing
the workflow (not assumed):
- Confirmed `npm test` is fully green (111 tests / 17 files) with
  `ANTHROPIC_API_KEY` explicitly unset in the shell — no accidental live-call
  dependency. `tests/actor/provider.test.ts`'s one reference to that env var
  name is just a comment explaining the SDK-module mock, not an actual read
  of it.
- Confirmed `npm run typecheck`, `npm run build`, and `npm run lint` are all
  clean locally first, so the workflow isn't the first thing to catch a
  pre-existing failure.
- Confirmed (by reading `src/browser/session.ts`) `launchBrowser()` really
  does default `headless: true` with nothing in the test suite overriding
  it — no Xvfb step needed, matching this file's baseline note.
- Kept `--with-deps` on the `playwright install` step rather than dropping
  it: Playwright's own CI guidance is that a bare `ubuntu-latest` image is
  missing shared libraries (nss, gtk, etc.) Chromium needs even in headless
  mode — this isn't a headless-vs-headed distinction, so the flag stays.
  This is a reasoned default, not yet empirically confirmed against an
  actual Actions run (see below).
- `better-sqlite3@^12.11.1`'s prebuilt binary install on `ubuntu-latest`
  and the actual pass/fail of the workflow itself **could not be verified
  from this session** — that requires a real push/PR against the GitHub
  remote (`origin` = `jamesmyers4/Drover`), which is a shared-state action
  outside this session's scope per this file's own stated convention ("the
  user reviews and commits manually between sessions"). Left "Current
  session" pointed back at finishing Session 1's verification rather than
  advancing to Session 2, since the "Done means" bar (a real Actions run
  passing) isn't met yet. User: commit and push (or open a PR) to close
  this out, then let the next session update this log with what actually
  happened in the Actions tab and flip to Session 2.
