# Drover Testing — status snapshot

Drover's test infrastructure buildout (Sessions 1–4, historical plan and
decisions log preserved below) is done. This section is a snapshot of what
exists and how to use it, not a forward-looking plan — same shape treeLine's
own `TESTING.md` settled into once its buildout finished. Read `CLAUDE.md`
and `CONTEXT.md` first, same as any other work in this repo.

## What exists

- **Unit/integration tests** — 26 files, 208 tests (`vitest run` / `npm
  test`, current as of 2026-07-25 — trust a fresh `npm test` run's own
  summary over this number if it's drifted). Real coverage, not
  placeholder: `tests/fixtures/site.ts` is a local `node:http` fixture
  server that browser-driven tests launch real Playwright chromium
  against. `ScriptedModelProvider`/`ScriptedAnalystProvider` stand in for
  the real Anthropic SDK in loop/orchestrator/analyst tests so those
  suites run with no API key and no network dependency;
  `tests/actor/provider.test.ts` and `tests/analyst/provider.test.ts`
  separately mock the `@anthropic-ai/sdk` module itself to cover the
  real-provider code paths (request shaping, cost computation, malformed-
  output handling) without live calls. Session 2's constraint-coverage
  audit confirmed every one of `CLAUDE.md`'s non-negotiable constraints has
  a findable test (or a documented structural guarantee where a test would
  just re-assert a type signature) — see that session's decisions-log entry
  below for the item-by-item disposition.
- **Golden-master pipeline tests** — `tests/golden/`: `normalize-golden.ts`
  (strips ephemeral fixture-server ports and UUID-shaped values before
  comparison), `dump-run.ts` (flattens a `runDiscovery` call's DB rows into
  a stable, sorted shape — primitive actions only, passive observation
  events excluded since their relative arrival order is a genuine runtime
  race, not meaningful signal), `golden-file.ts` (diffable string
  comparison, not `toEqual`), and 3 locked scenarios in
  `run-discovery.golden.test.ts` (clean run, mixed outcomes, budget-
  stopped), each driven directly through `runDiscovery` against the real
  fixture browser with `ScriptedModelProvider`. Regenerate with
  `UPDATE_GOLDEN=1 npm test` after an intentional behavior change. A 4th
  scenario locking down `drover analyze`'s cross-session output is
  deliberately deferred until Session 6's reporting work gives it a real
  consumer — see that session's plan entry below.
- **CI** — `.github/workflows/test.yml` runs on every push/PR to `main`:
  checkout, Node 20 (`actions/setup-node`, built-in `cache: npm`), `npm
  ci`, `npx playwright install --with-deps chromium`, then `typecheck` →
  `build` → `lint` → `test`, on `ubuntu-latest`, no matrix. Runs with no
  `ANTHROPIC_API_KEY` set — expected and confirmed clean, since every test
  that touches a model either uses a scripted provider or mocks the SDK
  module directly. The golden suite needs no separate CI step: it's just
  more `*.test.ts` files under `tests/`, picked up by the same `npm test`
  (`vitest run`) invocation everything else runs under — there's no
  `vitest.config.*` narrowing the default file glob, confirmed by its
  absence from the repo. A status badge linking to the workflow is at the
  top of `README.md`.

## How to reproduce locally

```bash
npm ci
npx playwright install --with-deps chromium   # first time, or to match CI exactly
npm run typecheck
npm run build
npm run lint
npm test                        # includes the golden suite, no separate command
UPDATE_GOLDEN=1 npm test         # regenerate golden files after an intentional behavior change
```

## Deliberately out of scope

- **No `packages/verify` analog** — treeLine's `verify` tool answered "does
  this nav link's real destination match what the crawl recorded?" against
  a live authenticated target. Drover's analogous "does this behave
  correctly against a real model" question is already answered by the
  three existing real-model smoke scripts (`smoke:actor`,
  `smoke:orchestrator`, `smoke:analyst`) — manual, on-demand, needs a live
  `ANTHROPIC_API_KEY`, not CI-gated, and not planned to become one. If a
  real Horse Haven Ops run later surfaces a class of question that
  genuinely needs live/manual verification the smoke scripts don't cover,
  that's a new `GAPS.md` entry when it happens, not something to build
  preemptively.
- **No Xvfb** — `launchBrowser()` (`src/browser/session.ts`) defaults
  `headless: true` and nothing overrides it, confirmed by reading the code
  during Session 1, not assumed.
- **No OS/Node matrix, no separate Playwright-browser cache step** — v1
  CI scope, matching `CLAUDE.md`'s "Phase 1 scope only" discipline applied
  to test tooling.

## Historical record

Everything below (Sessions 1–4's plan text and the dated decisions log) is
kept as-is from the buildout for reference — not a live plan to re-run.

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
  Confirmed necessary/working, not just reasoned: the step ran successfully
  in the real Actions run below (30s).
- Pushed to `origin/main` (commit `4a1f580`) and watched the real run
  (`jamesmyers4/Drover` Actions run `30137414469`) execute on
  `ubuntu-latest`: every step succeeded — `npm ci` (confirms
  `better-sqlite3@^12.11.1`'s prebuilt binary installs cleanly on this
  runner, ~99s, no from-source build fallback triggered), `npx playwright
  install --with-deps chromium` (~30s), then `typecheck`/`build`/`lint`
  (each <1s once deps existed) and `test` (~8s, matching the local 111/17
  count). Total job time ~2.5 minutes end to end. No matrix, no separate
  browser cache step — v1 scope holds.

**2026-07-24 (Session 2 — Constraint-coverage audit)** — Went through
`CLAUDE.md`'s non-negotiable constraint list item by item. Disposition for
each (four genuine gaps closed with new tests, the rest already covered or
structural):

- **Sequential-only / `concurrencyCap > 1` rejection, checked before
  `db.insertRun`** — gap closed. The existing
  `tests/orchestrator/run-discovery.test.ts` case only asserted the throw;
  it didn't prove *when*. Added `vi.spyOn(db, "insertRun")` to that test and
  assert it's never called — confirms `assertConcurrencyCapSupported` really
  does fire before any run row is written, not just that the error message
  matches.
- **`restricted` dataPolicy refusing a non-`anthropic` provider** — already
  covered: `tests/actor/provider.test.ts`'s `assertDataPolicyAllowed`
  describe block (both the allow and reject paths).
- **`fill()` value never entering the event log** — already covered, and
  already asserts absence, not just presence:
  `tests/browser.test.ts` › "fill logs the selector but never the value"
  loops every logged event and asserts none contain the literal fill value.
- **Run-level hard ceiling checked between sessions, never mid-session,
  never dies mid-write** — already covered behaviorally
  (`tests/orchestrator/run-discovery.test.ts` › "stops scheduling once the
  run-level cost ceiling is hit..." — `orgSize: 5` but only 1 session runs,
  teardown still fires). Also confirmed structurally by reading
  `src/orchestrator/run-discovery.ts`: `config.budget.runCeilingUsd` is only
  ever referenced in the orchestrator's own `for` loop, never passed into
  `runPersonaSession` — so "checked mid-session" isn't just untested, it's
  not wired up to be possible.
- **Per-persona-session soft cap ending a session `budget-capped`** —
  already covered: `tests/actor/loop.test.ts` › "ends budget-capped once the
  soft cap is spent, distinct from a hard-stop".
- **Analyst `analystCeilingUsd` pre-flight throwing before
  `provider.analyze()` is called** — already covered, and already asserts
  the provider was never invoked: `tests/analyst/analyze.test.ts` › "throws
  AnalystBudgetExceededError and never calls the provider..." spies on
  `provider.analyze` and asserts zero calls.
- **Malformed `decide_action` cost still recorded against budget** —
  already covered: `tests/actor/loop.test.ts` › "records the billed cost of
  a malformed decide_action call against budget, not just successful ones".
- **Two-phase reconciliation's `crossSessionDataComplete` flag** — already
  covered at both the unit level (`tests/orchestrator/reconcile.test.ts`,
  two dedicated cases) and end-to-end
  (`tests/analyst/analyze.test.ts` › "corrects a premature 'resolved' tag
  left by the orchestrator's pre-analyst reconciliation pass").
- **Reasoning capture is one sentence, not multi-field chain-of-thought** —
  genuine gap found, not closed with a test: `DECIDE_TOOL`'s `reasoning`
  schema field (`src/actor/provider.ts`) has no length/sentence-count
  constraint, only a non-empty check. The *multi-field* half is structurally
  impossible (only one `reasoning` field exists in the type at all); the
  *one-sentence* half is prompt-instruction-only and unenforced. Logged to
  `GAPS.md` per this file's own instruction for this exact case rather than
  writing a test that would really just be asserting scripted-provider
  behavior against a schema, not real model adherence.
- **Screenshots/traces only at finding-flag time, never per-action** — gap
  closed. `src/browser/screenshot.ts`'s `captureScreenshot` is (confirmed by
  grep) only ever called from `src/actor/findings.ts`'s
  `recordInSessionFinding` — never from `src/browser/session.ts`'s
  primitives. The existing loop test only proved the positive half
  (`screenshotPath` defined when a finding fires); added one assertion to
  the "succeeds when the success checkpoint is reached" case (zero findings
  on a clean run) as the negative-half proxy, since a zero-finding session
  is exactly the case where "never per-action" would be violated if it were
  wired wrong.
- **Secrets never entering prompt content** — documented structural
  guarantee, no test added (this file's own suggested resolution for this
  exact item). `src/actor/prompt.ts`'s builder signatures
  (`StaticPromptInput` etc.) only ever accept `DomainPack`/`Goal`/
  `PersonaArchetype`/a `routeMapContext` string — confirmed by reading the
  file that no parameter shape exists that could carry `storageState`,
  cookies, or API keys even by mistake. A regression test here would just
  re-assert a type signature, not guard a real code path.
- **CHECK-constraint-enforced enums** — gap closed for 4 of the 5 tables
  that had one. `runs.status` and the `sessions` FK were already covered
  (`tests/db.test.ts` › "enforces foreign keys and status check
  constraints"), but `sessions.status`, `in_session_findings.type`/
  `.severity`, `cross_session_findings.type`/`.severity`, and
  `finding_status_history.finding_kind`/`.status` had no invalid-value test
  at all — only round-trip-with-valid-values coverage. Added 4 new cases to
  `tests/db.test.ts` asserting each rejects with `/CHECK/`.
- **Domain-pack `teardown` runs finally-style even after a crash** —
  already covered: all three `tests/orchestrator/run-discovery.test.ts`
  scenarios (normal completion, budget-stopped, crashed-on-unknown-goal)
  assert `teardownCalls` has exactly one entry.
- **Zero write access beyond the target app's own UI** — structural, nothing
  to test. Grepped `src/` for `fetch(`/`axios`/`http.request`/
  `https.request`: zero hits outside the Anthropic SDK client and
  Playwright's own browser-driven requests. No code path exists that could
  write anywhere else.

Net: 4 new test cases added across 2 files (`tests/db.test.ts` ×4 new
`it()`s; `tests/orchestrator/run-discovery.test.ts` and
`tests/actor/loop.test.ts` each gained one assertion inside an existing
test, not a new `it()`), plus one new `GAPS.md` entry. Test count went from
111 to 115. `npm run typecheck`/`build`/`lint`/`test` all still clean.

**2026-07-24 (Session 3 — Golden-master pipeline layer)** — Built
`tests/golden/` per the plan: `normalize-golden.ts` (deep-walks a JSON value
replacing the fixture site's ephemeral `baseUrl` with `<BASE_URL>` and any
UUID-shaped substring with `<UUID>`), `dump-run.ts` (flattens a
`runDiscovery` call's DB rows into a stable, sorted shape), `golden-file.ts`
(`expectMatchesGolden` — compares serialized strings, not `toEqual`, so a
failure prints a real line-by-line diff), and 3 locked scenarios in
`run-discovery.golden.test.ts` (clean run, mixed outcomes, budget-stopped),
each driven directly through `runDiscovery` against the real fixture
browser with `ScriptedModelProvider`. The 4th (analyst cross-session)
scenario is deliberately deferred, per the plan's own note — no reporting
consumer exists yet to make locking down raw `cross_session_findings` rows
worthwhile.

Real finding, not assumed — a genuine flaky-golden-file bug caught by
actually running the suite repeatedly (20 back-to-back runs), not by
inspection: the first `dump-run.ts` draft included every raw
`action_events` row per session, sorted by `(timestamp, actionType,
target)`. That still flaked (~1 in 5–8 runs) because a failed navigate's
synchronous `action-error` (logged from `performAction`'s catch block) and
Playwright's async `requestfailed`-driven `http-failure` observation for
that *same* failure are two independent listeners with no fixed relative
order — sometimes one's real timestamp is a millisecond earlier, sometimes
the other's, so no sort key built from real timestamps can pin it down;
it's a genuine runtime race, not a tie-breaking artifact. Fix: narrowed
`dump-run.ts`'s `events` to primitive actions only
(`navigate`/`click`/`fill`) and dropped passive observation events
(`console-error`/`http-failure`/`page-error`/`action-error`) from the dump
entirely — their relative arrival order isn't meaningful behavior to lock
down, and the `findings` list (already deduped/sorted, unaffected by this
race) is what actually matters for regression coverage of errors. Verified
by rerunning the golden suite 20 times consecutively with zero failures
after the fix (vs. 2 failures in an earlier 15-run batch before it).
Designing the "mixed outcomes" scenario also deliberately avoided pairing
the fixture's console-error page with its 500 endpoint in the same
session, for a related reason documented inline in the test: Chromium logs
its own "Failed to load resource" console error for a 500 response *in
addition to* Drover's own tracked `http-failure` event for it (same
behavior `tests/actor/loop.test.ts`'s existing test already flagged with a
`.some()`-not-exact-count check) — pinning an exact finding count across
that interaction would make the golden file dependent on Chromium's own
network-failure console logging behavior, not on Drover's.
- Performed the corrupt-then-restore check required by this file: hand-edited
  `clean-run.json`'s `totalCostUsd` to a wrong value, reran the suite, got a
  correct human-readable diff (not a silent pass), then restored it. Also
  deleted `budget-stopped.json` entirely, confirmed the "Golden file ... does
  not exist" error path fires, then regenerated it via `UPDATE_GOLDEN=1` and
  confirmed the output byte-for-byte matched what it had before deletion.
- Confirmed `biome.json`'s `files.includes` (`["src/**", "tests/**",
  "scripts/**"]`) already covers `tests/golden/**` without any change —
  `npm run lint` picked up the new directory automatically (69 files
  checked, up from 62).
- The golden tests run as part of the normal `vitest run` / `npm test`
  invocation (no separate script or CI step) — `tests/golden/*.test.ts`
  matches vitest's default test-file glob same as every other suite.
- Test count went from 115 to 118 (3 new golden scenarios); file count from
  17 to 18. `npm run typecheck`/`build`/`lint`/`test` all clean.

**2026-07-24 (Session 4 — Wire into CI, close the loop)** — Confirmed,
didn't assume: re-read `.github/workflows/test.yml` (Session 1's file,
unchanged) and `package.json`'s `test` script (`vitest run`, no
`vitest.config.*` anywhere in the repo narrowing the default file glob) —
Session 3's `tests/golden/run-discovery.golden.test.ts` matches vitest's
default `*.test.ts` pattern same as every other suite, so it's already
running inside CI's existing `npm test` step. No new CI step needed; none
added. Ran `npm test` fresh to get a current, non-estimated count for this
file's new status snapshot: 18 files / 118 tests, all passing.

Asked the user whether to add a CI status badge to `README.md` (per this
session's own "ask rather than assuming" instruction) — yes. Added a
GitHub Actions badge for the `test` workflow (`jamesmyers4/Drover`) at the
top of `README.md`, linking to the Actions page.

Rewrote this file's top section (everything that used to sit above
"Session 1") into the status snapshot above, replacing the old
forward-looking "Baseline" / "What treeLine had" framing — the per-session
plan text and this decisions log are kept below as historical record, per
this session's own instruction, rather than deleted. `BUILD-STATE.md` was
not touched, per this session's "done means" — testing infra and feature
build sessions stay tracked separately.

No new residual gaps surfaced during this session worth a `GAPS.md` entry
— Sessions 1–3's work was already correctly wired (CI already ran
everything under `npm test` including the golden suite; nothing was
silently disconnected). The one deferred item already on record — a 4th
golden scenario for `drover analyze`'s cross-session output, waiting on
Session 6's reporting consumer — is test-infrastructure scope, not a
product/behavior gap, so it stays documented here (Session 3's plan entry
and this file's new status snapshot) rather than duplicated into
`GAPS.md`, consistent with this file's own test-infra-vs-`GAPS.md` split.

Testing buildout (Sessions 1–4) is now complete. Stopping here per this
session's scope — Session 5 (`BUILD-STATE.md`'s next feature session,
reporting) is out of scope for this file's work and was not started.

**2026-07-25 (TESTING-GAPS.md Session 1 — actor tier: route map + prompt
assembly)** — First session of the separate, dated `TESTING-GAPS.md` coverage
sweep plan (its own session numbering, unrelated to Sessions 1–4 above).
Closed the two worst-covered actor-tier files:

- New `tests/actor/route-map.test.ts`: drives `buildRouteMapContext` (the
  only exported entry point) with a fake `TreelineAdapter` rather than
  exporting `extractRoutes` just to unit-test it directly — every
  `extractRoutes` branch (href-regex matching, `Set`-based dedup, the
  `MAX_ROUTES` cap, and the catch-and-skip on a genuinely malformed URL) is
  reachable through `buildRouteMapContext` alone. Also covers: `"new"`
  familiarity returning `undefined` without ever calling the adapter, empty/
  no-links HTML, `resolveSeedUrl` resolving with `html: null`, and
  `resolveSeedUrl` rejecting (caught, not thrown). `src/actor/route-map.ts`
  went from 16%/10%/33.3%/— (stmts/branch/funcs) to 96%/90%/100%/100%
  (stmts/branch/funcs/lines).
- Real finding made while writing the malformed-link test: the module's own
  doc comment above `extractRoutes`'s catch block claims mailto:/javascript:
  links are skipped as "not a resolvable URL" — verified against Node's
  actual `URL` constructor (both `new URL("mailto:...", base)` and
  `new URL("javascript:...", base)` parse successfully as absolute URLs with
  their own scheme, they never throw) that this is wrong: these links are
  *not* skipped, they land in the route list with an opaque, path-shaped
  value (e.g. `mailto:a@b.com` → route `a@b.com`). Per this session's own
  "don't fix source" constraint, added a test that documents the real
  (surprising) behavior instead of the comment's claimed behavior, rather
  than silently matching the wrong assumption or changing the source
  comment. Not logged to `GAPS.md` — cosmetic (stale comment vs. actual
  low-value route-map noise), not a correctness/security issue.
- New `tests/actor/prompt.test.ts` (no prior file existed): all three
  `techSavvinessFraming` bands, all three `deviceFraming` values, all three
  `familiarityFraming` values, both branches of the `routeMapContext`-present
  check in `buildStaticSystemPrompt`, and `buildActionPrompt`'s empty-vs-
  non-empty `recentHistory` fallback. `src/actor/prompt.ts` went from
  69.6%/50%/100% to 100%/100%/100%.
- Test count went from 24 files/173 tests (this sweep's own recorded
  baseline) to 26 files/196 tests. `npm run typecheck`, `npm run lint`, and
  `npm test` all clean. `@vitest/coverage-v8` was already present in
  `node_modules` from the original sweep's `--no-save` install — reused it
  to confirm the before/after numbers above rather than re-installing;
  Session 10 (per `TESTING-GAPS.md`) still owns making it a committed
  `devDependency`.
- Also refreshed this file's stale "18 files / 118 tests" snapshot line
  above to the current count while touching this file anyway, per
  `TESTING-GAPS.md`'s own Session 10 note flagging that drift — a
  documentation nit, not new coverage work.

`TESTING-GAPS.md`'s Session 1 entry updated in place (struck through with a
"CLOSED 2026-07-25" disposition) rather than deleted, matching this file's
own historical-record convention.

**2026-07-25 (TESTING-GAPS.md Session 2 — actor tier: decision validation +
loop pacing/fill)** — Closed the remaining gaps in `src/actor/provider.ts`
and `src/actor/loop.ts`:

- Extended `tests/actor/provider.test.ts` with two `it.each` blocks (one
  per provider) covering the five `parseDecision` validation branches never
  exercised through a real provider before: invalid `actionType`, `navigate`
  missing `url`, `click` missing `selector`, `fill` missing `selector`, and
  `fill` missing `value` — each asserting `MalformedDecisionError` with a
  message matching the specific `DecisionParseError` reason.
  `src/actor/provider.ts` went from 90.7%/84.9%/100% to
  96.51%/93.15%/100%/96.29% (stmts/branch/funcs/lines).
- Decision on the `throw err;` rethrow-of-non-`DecisionParseError` branches
  (`src/actor/provider.ts` lines 206 and 306, one per provider): left
  untested. `parseDecision` isn't exported and only ever throws
  `DecisionParseError`, so forcing this branch would mean `vi.mock`-ing the
  provider module's own internals to inject a different throw type — real
  mocking complexity for a branch that's genuinely defensive/unreachable
  today, not a behavior anyone depends on. Recorded per this plan's own
  "either is fine, just record the decision" allowance. Also left alone:
  line 120 (a non-object tool-call `input`/`arguments` payload) — flagged
  lower-priority in `TESTING-GAPS.md` itself, not pursued.
- Extended `tests/actor/loop.test.ts` with two new cases: one that leaves
  pacing enabled (`patience: 0`, the longest real per-action wait
  `pacingMsForPatience` can produce — a real ~1s wall-clock wait across the
  two-action scenario, accepted the same way this suite's existing
  browser-driven tests already accept real waits) and asserts the session
  still completes and succeeds correctly; one that drives an `actionType:
  "fill"` decision through `runPersonaSession` end to end against the
  fixture site's `/signup` form (`#signup-name`), asserting the fill event
  lands in the DB with the right target. `src/actor/loop.ts` went from
  95.9%/80.4%/87.5% to 98.97%/86.27%/100%/98.92%. The one line still
  uncovered (74, `executeAction`'s `"finish"` case) is the same
  already-`GAPS.md`-logged dead-code observation `TESTING-GAPS.md`'s own
  intro already calls out — not a new finding, not pursued further here.
- Test count went from 26 files/196 tests to 26 files/208 tests (12 new
  cases: 10 `it.each` rows across both providers + 2 new loop cases).
  `npm run typecheck`, `npm run lint`, and `npm test` all clean.

`TESTING-GAPS.md`'s Session 2 entry updated in place with a "CLOSED
2026-07-25" disposition, same convention as Session 1.
