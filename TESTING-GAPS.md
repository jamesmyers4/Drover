# TESTING-GAPS.md — coverage sweep findings and a session-by-session plan to close them

This is the output of a targeted sweep through Drover's test suite against its
source, done against real instrumented coverage numbers (`@vitest/coverage-v8`,
installed temporarily for this sweep — not currently a `package.json`
dependency; see Session 10 below for the recommendation to add it
permanently). `CONTEXT.md`, `CLAUDE.md`, `TESTING.md`, `GAPS.md`, and
`TREELINE-GAPS.md` were all read first, per this sweep's own instructions.

**Baseline, measured 2026-07-25** (`npx vitest run --coverage`, 24 test files,
173 tests, all green): **87.66% statements / 79.63% branches / 93.24%
functions / 89.04% lines** across `src/**`. That headline number undersells
how uneven it is — most of the gap is concentrated in a handful of files
that are near-zero, dragging a suite that's otherwise mostly in the
high-90s/100%. `src/types/*.ts` and the barrel `index.ts` files across every
directory are type-only or pure re-exports (0 executable statements) — they
correctly show 100% and needed no attention here.

Two non-test observations turned up along the way (dead-code-shaped, not
behavior bugs) and were logged to `GAPS.md` instead of here, per this repo's
existing test-infra-vs-behavior split: `executeAction`'s `"finish"` case in
`src/actor/loop.ts` looks unreachable, and `page-error` events never produce
an in-session finding the way `console-error`/`http-failure` do. Nothing in
this file should be read as a request to change source behavior — every
session below is additive test coverage only.

## How to reproduce the numbers in this file

```bash
npm install --no-save @vitest/coverage-v8   # not a committed dependency yet — see Session 10
npx vitest run --coverage
```

Add `--coverage.all=true --coverage.include='src/**'` to also force-include
source files that no test imports at all (this is what caught `src/cli/index.ts`
sitting at a flat 0%) — the default run silently omits any file no test ever
loads, which looks identical to "100%, nothing to report" unless you know to
check for it.

## Findings, worst-first

Each entry: current numbers, what's actually untested (verified by reading
the source against its test file, not just trusting the percentage), and
which session below closes it.

### `src/cli/index.ts` — 0% / 0% / 0% (96 statements, 26 branches, 11 functions) → Session 10

Completely untested by `npm test`/CI. The only thing that ever exercises this
file is `npm run smoke:orchestrator`, a manual script not run in CI (by
design, per `TESTING.md` — but that design decision was about *model
behavior* verification, not CLI wiring). Nothing here would catch a broken
flag, a wrong default, or a swallowed error if the CLI layer itself changed.
`parseConcurrencyLevels` (a pure validation function — comma-split, integer
check, `>= 1` check) has zero coverage despite being trivially unit-testable
in isolation. `runCommand`/`analyzeCommand`/`reportCommand`/`stampedeCommand`
and their `try { ... } catch { console.error(...); process.exitCode = 1; }`
wrapping are entirely unexercised. None of these four functions are
`export`ed today — closing this gap needs a small, additive,
non-behavioral change (adding `export` to each) or driving everything
through `program.parseAsync()` with a fabricated `argv`; Session 10 lays out
the tradeoff.

### `src/analyst/provider.ts` — 37.5% / 22.2% / 40% (48 statements, 27 branches, 10 functions) → Session 3

`BatchAnalystProvider.analyze()` — the real Batch API lifecycle
(`batches.create` → poll `batches.retrieve` until `processing_status ===
"ended"` → `batches.results` stream → find the matching `custom_id` → check
`result.type === "succeeded"` → find the `tool_use` block → compute
Batch-discounted cost) — has **no direct test at all**.
`tests/analyst/provider.test.ts` only covers `ScriptedAnalystProvider` and
the `createAnalystProvider` factory switch; it never mocks
`@anthropic-ai/sdk` to actually drive `BatchAnalystProvider` the way
`tests/actor/provider.test.ts` already does for `AnthropicModelProvider`.
Every error path (`AnalystBatchError` for "no result for this custom_id",
"result did not succeed", "no report_cross_session_findings tool_use block")
is unexercised. This is the single largest real gap in the suite — the
actor tier's equivalent (`AnthropicModelProvider`) is well-covered by
comparison, so the pattern to copy already exists in the repo.

### `src/actor/route-map.ts` — 16% / 10% / 33.3% (25 statements, 10 branches, 3 functions) → Session 1

`extractRoutes` (the HTML-link-scraping regex walk, capped at
`MAX_ROUTES`, deduped via `Set`) has no direct unit test whatsoever.
`buildRouteMapContext` is only ever exercised indirectly through
`tests/actor/loop.test.ts`, and every one of those tests uses
`familiarity: "new"` (which returns `undefined` at the first line, before
any of the real logic runs) with a stub `TreelineAdapter` that always
rejects `resolveSeedUrl`. So the entire "returning/veteran persona actually
gets a route map" path — the one this whole module exists for — has never
been proven to work.

### `src/actor/prompt.ts` — 69.6% / 50% / 100% (23 statements, 14 branches) → Session 1

There is no `tests/actor/prompt.test.ts` at all — `buildStaticSystemPrompt`
and `buildActionPrompt` are only ever exercised as a side effect of
`tests/actor/loop.test.ts`, which always uses the same archetype shape
(`techSavviness: 0.5`, `deviceType: "desktop"`, `familiarity: "new"`, no
`routeMapContext`). Concretely untested: `techSavvinessFraming`'s low
(`< 0.34`) and high (`>= 0.67`) branches (only the middle "average comfort"
branch ever runs), `deviceFraming`'s `"mobile"`/`"tablet"` branches (only
`"desktop"` runs), `familiarityFraming`'s `"returning"`/`"veteran"`
branches (only `"new"` runs), and the `routeMapContext`-present branch in
`buildStaticSystemPrompt` (lines 77–81) that appends the "you've been here
before" section.

### `src/orchestrator/run-discovery.ts` — 76.5% / 78% / 90.9% (98 statements, 41 branches) → Session 5

Three real gaps, all inside `runOneScheduledSession`'s exception handling
and the outer `finally`:
- **`sessionsErrored` is asserted `=== 0` in two existing tests but never
  asserted `> 0`.** CLAUDE.md explicitly documents this as a distinct
  counter from `sessionsHardStopped` ("an exception escaping session setup
  entirely" vs. the actor loop's own hard-stop), but nothing proves the
  `catch` block at the bottom of `runOneScheduledSession` (the one that
  increments `sessionsErrored` and force-marks the session `hard-stopped`)
  actually fires and behaves correctly.
- **A `domainPack.teardown` hook that itself throws** — the
  `console.error(...)` catch around the teardown call — is never
  triggered.
- **`reconcileRunFindings` throwing** — the analogous catch around the
  post-run reconciliation call — is never triggered.

### `src/orchestrator/schedule.ts` — line 56 (the `drawWeightedGoal` fallback) → Session 5

Worth flagging on its own: `tests/orchestrator/schedule.test.ts` already has
a test named *"falls back to the last goal on a boundary rounding case"*
using `rand: () => 0.999999999` — but tracing the actual arithmetic (weights
`{a: 1, b: 3}`, `total = 4`, `r = 0.999999999 * 4 = 3.999999996`) shows this
draw is still satisfied by the normal `r < w.weight` check on `b` inside the
loop (`2.999999996 < 3` is true) and never reaches the `return
(weights[weights.length - 1] as WeightedGoal).goalId;` fallback on line 56
at all. **The existing test's name and comment claim coverage it doesn't
actually have** — real hits on the fallback need `rand: () => 1` exactly
(or another input that leaves `r >= total` after the loop completes), not a
value merely close to 1.

### `src/db/database.ts` — 92.6% / 89.4% / 97.7% (81 statements, 66 branches) → Session 6

A consistent, mechanical gap across several single-row getters: none of them
are ever tested for the "not found" path (they all correctly `return
undefined`, but nothing asserts it):
- `getSession(id)` (line 174)
- the in-session finding single-row getter (line 286)
- the cross-session finding single-row getter (line 349)
- `getStampedeRun(id)` (line 538)

Two more, distinct from the above:
- **Migration idempotency is untested.** `migrate()`'s `if
  (applied.has(m.version)) continue;` (line 53) — the "skip a migration
  that's already been applied" branch — can only be reached by reopening a
  *file-based* (non-`:memory:`) database that already has migrations
  recorded, since a fresh `:memory:` db (what every test uses) always starts
  with zero applied migrations. No test does this.
- `updateRunStatus`/`updateSessionStatus`'s `endedAt ?? null` branch (the
  case where `endedAt` isn't passed at all) is never exercised — every
  call site in every test passes an explicit timestamp.

### `src/report/report.ts` — 90.6% / 73% / 100% (53 statements, 37 branches) → Session 7

`buildRunReport`'s reconciliation tally (`reconciliation.stillOpen++` /
`reconciliation.resolved++`, lines ~157–159) is never verified —
`tests/report/report.test.ts`'s fixtures only ever produce `"new"`-status
findings, so the `else if` branches for `"still-open"` and `"resolved"` are
dead in the test suite even though `renderMarkdownReport`'s "Since last run"
section (and its own golden fixtures) assumes all three are reachable. Also
untested: a cross-session finding carrying its own `screenshotPath`
straight through to `buildRunReport`'s evidence (line 136) — the existing
cross-session-finding test never sets one.

### `src/report/markdown.ts` — 95% / 73% / 100% (40 statements, 26 branches) → Session 7

The "analyst spend with no ceiling configured" branch (`else if
(report.analystCostUsd !== undefined)`, lines 69–73) is untested — both
existing golden fixtures (`report-mixed-findings`, `report-empty`) set
`budget.analystCeilingUsd`, so the "an analyst pass ran, but this run never
had a ceiling configured" case — a perfectly normal state for any run
predating that config option, or one that just never set it — has no
golden coverage.

### `src/stampede/run-stampede.ts` / `replay.ts` → Session 8

- `SourceRunNotFoundError` (`run-stampede.ts` line 88, thrown when
  `sourceRunId` doesn't resolve to a real run) has no test at all —
  `tests/stampede/run-stampede.test.ts` never calls `runStampede` with a
  bogus `sourceRunId`.
- `replay.ts`'s `catch` block (line 43 — "navigation timeout, connection
  refused, etc." per its own comment) is untested. The existing
  "errors under load" test case (`/api/horses/page2`) only exercises the
  *response-status* error path (`response.status() >= 400`, a completed
  HTTP response), never a real `page.goto()` exception. These are genuinely
  different failure shapes worth distinguishing (a slow/broken route vs. an
  unreachable one).

### `src/treeline/adapter.ts` — 90.3% / 76.9% / 84.6% (31 statements, 13 branches, 13 functions) → Session 8

`StubTreelineAdapter.checkAuthStillValid()` and, in this environment
specifically, `StubTreelineAdapter.detectAuthWall()` are untested. This one
is environment-dependent and worth understanding before assuming it's
stable: the sibling `treeLine` checkout **is built** on this machine
(`C:\Users\james\Documents\treeLine\packages\acquire\dist\` exists), so
every `it.runIf(treelineBuilt)` test in `tests/treeline-adapter.test.ts`
actually runs against the **real** adapter, not the stub — including the
"detectAuthWall" test, which calls `createTreelineAdapter()` with no
override and so silently exercises `RealTreelineAdapter`, not
`StubTreelineAdapter`, here. The one test that explicitly targets the stub
(`"falls back to the stub when treeLine is not found"`) only calls
`performLogin` and `resolveSeedUrl`, not `checkAuthStillValid` or
`detectAuthWall`. On a machine without treeLine built, the coverage picture
for this file would look different again (the `runIf` tests would all skip)
— worth keeping in mind if this file's numbers ever look like they moved
for no reason.

### `src/actor/provider.ts` — 90.7% / 84.9% / 100% (86 statements, 73 branches, 13 functions) → Session 2

`parseDecision`'s individual validation branches are only proven once each
(via the "missing or empty reasoning" case, tested for both
`AnthropicModelProvider` and `OllamaModelProvider`). Never exercised through
either real provider: invalid `actionType` value, `actionType: "navigate"`
missing `url`, `actionType: "click"`/`"fill"` missing `selector`,
`actionType: "fill"` missing `value`, and a non-object tool-call payload.
Lower priority, arguably not worth a test at all: the `throw err;` rethrow
of a non-`DecisionParseError` (lines 206 and 306) is presently unreachable
given `parseDecision` only ever throws `DecisionParseError` — flag it as a
"test if you can cheaply force it, otherwise leave it" item rather than a
must-fix.

### `src/actor/loop.ts` — 95.9% / 80.4% / 87.5% (98 statements, 51 branches, 8 functions) → Session 2

`pacingMsForPatience` (line 47) never executes — every test in
`tests/actor/loop.test.ts` and `tests/orchestrator/run-discovery.test.ts`
passes `disablePacing: true`, so the patience-derived wait-between-actions
behavior CLAUDE.md documents ("`patience` shapes retry/wait behavior") has
literally never run once in the entire suite. `executeAction`'s `"fill"`
case (lines 68–72) is also never reached at the loop level — no scripted
scenario ever hands the loop a `fill` decision end to end (checkpoint- and
provider-level `fill` handling are tested elsewhere, but not through
`runPersonaSession`).

### `src/browser/session.ts` — 92.7% / 73.1% / 95% (55 statements, 26 branches, 20 functions) → Session 9

The `pageerror` listener (lines 102–108 — Playwright's event for an
*uncaught JS exception* on the page, distinct from `console.error`) is
completely untested. This isn't just a missing assertion — `tests/fixtures/site.ts`
has no page that actually throws an uncaught exception (`/broken` only
calls `console.error`), so there's currently no way to exercise this
listener without adding fixture content first.

### `src/browser/screenshot.ts` — 85.7% / 100% / 100% (7 statements) → Session 9

The failure path (`catch { return undefined; }`, line 29 — capture must
never crash a finding) is untested. Nothing forces `mkdirSync` or
`page.screenshot` to throw.

### Smaller / lower-priority items → Session 6

- `src/matching/match-key.ts` line 27: `normalizeRoute`'s `url.pathname ||
  "/"` fallback branch — needs a URL-shaped target whose `pathname` parses
  to an empty string; not obviously reachable, worth a short investigation
  rather than assuming it's dead.
- `src/orchestrator/schedule.ts` line 72: `if (!archetype) throw new
  EmptyDomainPackError();` — appears structurally unreachable given line 64
  already guarantees `personas.length > 0` and the index is a modulo into
  that same non-empty array. Worth a one-line note rather than a test if a
  second read confirms it's genuinely dead (mirrors the `executeAction`
  "finish" case already logged to `GAPS.md`).
- `src/analyst/digest.ts` line 64: the "a later gap is *not* longer than an
  earlier one" branch of the `longestGapMs` tracking — only ever tested
  with event sequences where each gap is monotonically larger than the
  last, so nothing proves the "keep the max, don't just take the latest"
  behavior actually compares rather than overwrites.
- `src/analyst/analyze.ts`: statements are 100% covered, but
  `createAnalystProvider(...)` (the fallback used when `runAnalyst` isn't
  given an explicit `provider` override) is never actually constructed in
  any test — every existing test supplies `provider` directly. Pairs
  naturally with Session 3's `BatchAnalystProvider` SDK-mocking work.
- `src/analyst/budget.ts` line 56: `createApiTokenCounter`'s real
  `messages.countTokens` success path. This one is **already a known,
  documented gap** (`CLAUDE.md`'s Known Gaps section, `GAPS.md`) — no
  `ANTHROPIC_API_KEY` has ever been available in this build environment, so
  every existing test exercises the chars/4 fallback instead. Flagging it
  here only because it's mechanically closable the same way Session 3
  closes `BatchAnalystProvider`: mock `@anthropic-ai/sdk`'s
  `messages.countTokens` directly (no real network/credentials needed) to
  prove the success path's arithmetic, the same way `tests/actor/provider.test.ts`
  mocks `messages.create`.

## Session plan

Ten sessions, each independently sized for a fresh Claude Code session with
no memory of this sweep. Each should: write the tests, run `npm test`
(and re-run `npx vitest run --coverage` if the tool from "How to reproduce"
above is still installed) to confirm the target file's numbers actually
moved, run `npm run typecheck`/`npm run lint`, and leave a short dated
decision-log entry in `TESTING.md` (its own convention, not this file) —
this file should be treated as a punch list to work through and update
(strike through or annotate closed items), not a permanent record.

**Do not fix, refactor, or "clean up" any source file while adding these
tests.** If a test can't be written without a source change (Session 10's
CLI exports are the one known exception, called out explicitly below), stop
and log it back here rather than making the change unprompted.

### Session 1 — Actor tier: route map + prompt assembly — CLOSED 2026-07-25

Close `src/actor/route-map.ts` (16%) and `src/actor/prompt.ts` (69.6%,
currently no dedicated test file at all).

**Disposition:** `src/actor/route-map.ts` now 96%/90%/100%/100%
(stmts/branch/funcs/lines; up from 16%/10%/33.3%) via new
`tests/actor/route-map.test.ts`. `src/actor/prompt.ts` now 100% across the
board (up from 69.6%/50%/100%) via new `tests/actor/prompt.test.ts`. Real
finding along the way, not assumed: `extractRoutes`'s own doc comment
("Not a resolvable URL (mailto:, javascript:, etc.) — skip.") is wrong —
`new URL("mailto:...", base)` and `new URL("javascript:...", base)` both
parse successfully as absolute URLs with their own scheme rather than
throwing, so these links are *not* actually skipped; they end up in the
route list with an opaque, path-shaped value (e.g. `mailto:a@b.com` becomes
route `a@b.com`). Verified directly against Node's URL implementation
before writing the test, not just read off the source. Per this file's own
"do not fix source" instruction, the test documents the real behavior
instead of the comment's claimed behavior — not logged to `GAPS.md` since
it's cosmetic (a stale comment, not an incorrect security/correctness
behavior: mailto:/javascript: links ending up as low-value route-map noise
isn't a real problem). `extractRoutes` itself was not exported to test it
directly — the plan's suggested test target — since `buildRouteMapContext`
(the actually-exported function) already exercises every `extractRoutes`
branch (dedup via `Set`, `MAX_ROUTES` cap, catch-and-skip on a genuinely
malformed URL like `http://[invalid`) without needing a source change. One
branch left uncovered in `route-map.ts` (line 24, `if (!href) continue;`):
structurally near-unreachable given the href-capturing regex group requires
at least one non-empty, non-quote character to match at all — not worth
forcing artificially. Full disposition and the actual mailto:/javascript:
finding recorded in `TESTING.md`'s decisions log.

- New `tests/actor/route-map.test.ts`: unit-test `extractRoutes` directly
  against small HTML strings (relative hrefs, absolute hrefs, `mailto:`/
  `javascript:` links that should be skipped, duplicate hrefs deduped via
  the `Set`, more than `MAX_ROUTES` distinct links capped correctly). Then
  test `buildRouteMapContext` with a fake `TreelineAdapter` whose
  `resolveSeedUrl` returns real HTML for `familiarity: "returning"` and
  `"veteran"` (asserting a non-`undefined` formatted string comes back),
  empty HTML (asserting `undefined`), and a rejecting `resolveSeedUrl`
  (asserting the catch returns `undefined`, not a thrown error) — this
  last one only needs a fake `Browser`/adapter pair, not a real browser
  launch.
- New `tests/actor/prompt.test.ts`: `buildStaticSystemPrompt` with each of
  the three `techSavviness` bands, each of the three `deviceType` values,
  each of the three `familiarity` values, and both with and without
  `routeMapContext` set (asserting the "you've been here before" section
  only appears when it's set). `buildActionPrompt` with an empty
  `recentHistory` (asserting the "haven't taken any actions yet" fallback
  line) and a non-empty one.

### Session 2 — Actor tier: decision validation + loop pacing/fill — CLOSED 2026-07-25

Close the remaining `src/actor/provider.ts` and `src/actor/loop.ts` gaps.

**Disposition:** `src/actor/provider.ts` now 96.51%/93.15%/100%/96.29%
(stmts/branch/funcs/lines; up from 90.7%/84.9%/100%) via 10 new `it.each`
cases in `tests/actor/provider.test.ts` (5 validation scenarios ×
Anthropic/Ollama each: invalid `actionType`, `navigate` missing `url`,
`click` missing `selector`, `fill` missing `selector`, `fill` missing
`value`). `src/actor/loop.ts` now 98.97%/86.27%/100%/98.92% (up from
95.9%/80.4%/87.5%) via 2 new cases in `tests/actor/loop.test.ts`: pacing
left enabled (`patience: 0`, the longest real per-action wait) proving the
loop still completes correctly, and a `"fill"` decision driven end to end
against the fixture site's `/signup` form, asserting the event lands with
the right target. The `throw err;` rethrow-of-non-`DecisionParseError`
branches (lines 206, 306) were left untested, per this plan's own
either-is-fine allowance — `parseDecision` isn't exported, so forcing a
non-`DecisionParseError` throw from it would need a `vi.mock` around
`../../src/actor/provider.js` importing and overriding its own internals,
which is more mocking complexity than the defensive branch is worth; it's
structurally unreachable today given `parseDecision`'s only throw type.
Also left uncovered: `provider.ts` line 120 (non-object tool-call payload)
— lower priority per the plan's own text, not pursued. `loop.ts`'s one
remaining gap (line 74, `executeAction`'s `"finish"` case) is the same
already-logged `GAPS.md` dead-code observation this file's intro already
calls out, not new. Full detail in `TESTING.md`'s decisions log.

- Extend `tests/actor/provider.test.ts`: for both `AnthropicModelProvider`
  and `OllamaModelProvider`, add cases for an invalid `actionType`, a
  `"navigate"` decision missing `url`, a `"click"`/`"fill"` decision
  missing `selector`, and a `"fill"` decision missing `value` — each
  asserting `MalformedDecisionError` with a message matching the specific
  `DecisionParseError` reason. Decide whether the `throw err;`
  rethrow-of-non-`DecisionParseError` branches (lines 206, 306) are worth
  forcing via a `vi.mock`-injected non-`DecisionParseError` throw from
  `parseDecision`, or worth leaving alone as effectively-dead defensive
  code — either is fine, just record the decision.
- Extend `tests/actor/loop.test.ts`: one new case that omits
  `disablePacing` (or sets it `false`) with a low-patience archetype and a
  short, bounded action sequence, asserting the session still completes
  correctly (proving pacing doesn't break anything) — a real wall-clock
  wait is acceptable here given the existing tests already use a real
  browser and 30s timeouts. One new case with an `actionType: "fill"`
  decision against the fixture site's `/signup` form, asserting the loop
  completes the fill and records the event correctly (this can reuse the
  same `#signup-name` selector `tests/browser.test.ts`'s fill test already
  uses at the `BrowserSession` layer, just driven through
  `runPersonaSession` this time).

### Session 3 — Analyst tier: `BatchAnalystProvider`'s real lifecycle — CLOSED 2026-07-25

The single biggest gap in the suite. Mirror the mocking pattern
`tests/actor/provider.test.ts` already established for
`AnthropicModelProvider` (mock the whole `@anthropic-ai/sdk` module, since
`this.client.messages`/`this.client.messages.batches` are instance
properties, not prototype methods that can be spied on after construction).

New cases in `tests/analyst/provider.test.ts` for `BatchAnalystProvider`:
- Happy path: mock `batches.create` to return a batch with
  `processing_status: "ended"` immediately (no polling needed), mock
  `batches.results` to return an async-iterable stream yielding one line
  matching `custom_id: "run-analysis"` with `result.type: "succeeded"` and
  a `tool_use` block for `report_cross_session_findings` — assert the
  findings and `BATCH_DISCOUNT`-adjusted cost come back correctly.
- Polling: mock `batches.retrieve` to return `processing_status:
  "in_progress"` once, then `"ended"` — assert `analyze()` actually waits
  and retries rather than returning early (a short/zero `pollIntervalMs`
  constructor arg keeps this fast).
- Each `AnalystBatchError` path: no line in the results stream matches
  `custom_id`; a matching line whose `result.type !== "succeeded"`; a
  matching, succeeded line with no `report_cross_session_findings`
  `tool_use` block in its message content.

Also close `src/analyst/analyze.ts`'s one real branch gap here (natural
pairing, same mocking already in place): a `runAnalyst` call with no
`provider` option, asserting `createAnalystProvider` actually constructs a
real `BatchAnalystProvider` from `run.config.modelRouting.analyst` (mock
just enough of the SDK to avoid it trying a real network call — asserting
construction happened, e.g. via `instanceof`, is enough; it doesn't need to
run to completion).

**Disposition:** `src/analyst/provider.ts` now 97.91%/81.48%/100%/100%
(stmts/branch/funcs/lines; up from 37.5%/22.2%/40%) via 5 new cases in
`tests/analyst/provider.test.ts`, mocking `@anthropic-ai/sdk`'s
`messages.batches.{create,retrieve,results}` the same way
`tests/actor/provider.test.ts` already mocks `messages.create` for
`AnthropicModelProvider`: the happy path (already-`"ended"` on create, no
polling), the polling path (`retrieve` returns `"in_progress"` once then
`"ended"`, asserted called exactly twice), and all three `AnalystBatchError`
paths (no matching `custom_id`, matching-but-not-`"succeeded"`, and
succeeded-with-no-tool_use-block). `src/analyst/analyze.ts`'s
`createAnalystProvider` fallback branch is also now closed, in
`tests/analyst/analyze.test.ts`, via a `vi.mock` that wraps (not replaces)
the real `createAnalystProvider` export using `importOriginal` — captures
the constructed provider without needing to fake the whole SDK, since the
real, uncredentialed `Anthropic` client rejects fast on the actual
`analyze()` call (no network I/O attempted) rather than hanging, and the
test only asserts `instanceof BatchAnalystProvider` before that rejection
lands. Remaining small gaps in `provider.ts` (an `extractFindings` non-
object/non-array input guard, and the `createAnalystProvider` `opts`
branch) weren't in this session's scope and weren't pursued. Full detail in
`TESTING.md`'s decisions log.

### Session 4 — Analyst tier: remaining small gaps — CLOSED 2026-07-25

- `tests/analyst/digest.test.ts`: one new case with 3+ events where a
  *later* gap is smaller than an earlier one, asserting `longestGapMs`
  stays at the earlier, larger value (proves the tracking compares rather
  than just taking the last computed gap).
- `tests/analyst/budget.test.ts`: mock `@anthropic-ai/sdk`'s
  `messages.countTokens` directly (same technique as Session 3, no real
  credentials needed) to exercise `createApiTokenCounter`'s success path —
  this closes a gap `CLAUDE.md`/`GAPS.md` already call out as "never
  exercised against a live API," but doesn't actually need a live API, just
  a mocked one, to prove the arithmetic (`result.input_tokens` flowing
  through correctly).

**Disposition:** Both closed as specified. `src/analyst/digest.ts` now
96.66%/96.42%/100%/100% (stmts/branch/funcs/lines) — the one remaining
branch (line 64, `if (!prev || !cur) continue;`) is a defensive guard
structurally unreachable given the loop's own bounds already guarantee both
exist, not pursued. `src/analyst/budget.ts` now 100% statements (up from
already-100%, branch coverage now 66.66%) via two new cases:
`createApiTokenCounter`'s real success path (mocked `countTokens` resolving
with `input_tokens`, asserted both the returned count and the exact
`{model, system, messages}` request shape sent) and a case proving
`estimateAnalystCostUsd`'s *default* `countTokens` argument (i.e. no
explicit override — `createApiTokenCounter(model)` itself) reflects the
mocked exact count end to end, not just the already-covered injected-
`TokenCounter` path. One remaining branch (line 77, the `err instanceof
Error ? err.message : String(err)` non-`Error`-throw half inside the
fallback's `console.error`) not pursued — out of this session's scope.
Full detail in `TESTING.md`'s decisions log.

### Session 5 — Orchestrator: error isolation + the schedule fallback

- Extend `tests/orchestrator/run-discovery.test.ts`: one new case that
  forces a real exception during session setup (e.g., a `providerFactory`
  that throws synchronously, or a bad `deviceType`/context option that
  makes `BrowserSession.open` reject) and asserts `sessionsErrored` is
  incremented, the session lands as `"hard-stopped"` in the DB, and the
  run overall still completes (proving this is genuinely isolated from
  `sessionsHardStopped`, not just a relabeling of the same path). One new
  case with a `domainPack.teardown` that throws, asserting the run still
  reaches a terminal status and the thrown error doesn't propagate out of
  `runDiscovery` (the `console.error` catch swallows it). One new case
  where the DB is put in a state that makes `reconcileRunFindings` throw
  (e.g. closing the db early, or another cheap forcing mechanism — pick
  whichever is least invasive after a quick look at what
  `reconcileRunFindings` actually depends on) asserting the same.
- Extend `tests/orchestrator/schedule.test.ts`: fix the
  "falls back to the last goal" test's premise — either change its `rand`
  to `() => 1` (or another value proven by hand to leave `r >= total` after
  the loop) so it actually reaches line 56, or add a second, correctly-aimed
  case alongside the existing one and leave a comment explaining why
  `0.999999999` doesn't reach the fallback (worth keeping *a* test at that
  boundary value too, since "close to but not past the boundary" is its
  own real behavior worth locking down — just not the fallback line it
  currently claims to test).

### Session 6 — DB layer + matching

- Extend `tests/db.test.ts`: one "returns undefined for an unknown id"
  case per getter — `getSession`, the in-session finding getter, the
  cross-session finding getter, `getStampedeRun`.
- One new case that opens a real *file-based* `DroverDb` (a temp file
  path, not `:memory:` — clean it up in `afterEach`/`afterAll`), closes it,
  reopens the same file, and asserts the second `migrate()` call is a
  no-op (no error, no duplicate `schema_migrations` rows, and — most
  importantly — that reopening doesn't re-run any migration's `CREATE
  TABLE`/`ALTER` SQL a second time, which would throw on a real db file
  even though it silently can't on a fresh `:memory:` one masking the
  issue).
- One case each for `updateRunStatus`/`updateSessionStatus` called without
  an `endedAt` argument, asserting the stored value is `null`/absent as
  expected.
- Investigate `src/matching/match-key.ts` line 27 (the `url.pathname ||
  "/"` fallback): find a real target string that produces an empty
  `pathname` after `new URL(...)`, or confirm none exists in practice and
  note that in this file instead of forcing an artificial test.

### Session 7 — Report tier

- Extend `tests/report/report.test.ts`: a scenario that produces a
  `"still-open"` match key (a finding present in two consecutive runs —
  reuse the two-run pattern `tests/analyst/analyze.test.ts`'s "corrects a
  premature resolved tag" test already established) and a scenario that
  produces a `"resolved"` one (a finding open going into a run that simply
  isn't seen again), asserting `buildRunReport(...).reconciliation` counts
  both correctly. One case where a `CrossSessionFinding` fixture carries
  its own `screenshotPath`, asserting it flows through to the report row's
  `evidence.screenshotPath`.
- Extend `tests/report/markdown.test.ts`: a third golden scenario (or a
  non-golden unit assertion, whichever fits better alongside the existing
  two) with `budget.analystCeilingUsd` unset but `analystCostUsd` defined
  — the "an analyst pass ran, no ceiling was ever configured" case —
  asserting the "Analyst spend: ... (no ceiling configured)" line renders.

### Session 8 — Stampede + treeline

- Extend `tests/stampede/run-stampede.test.ts`: one case calling
  `runStampede` with a `sourceRunId` that doesn't exist in the db,
  asserting `SourceRunNotFoundError`.
- Add one route to `tests/fixtures/site.ts` (or use an already-unreachable
  target, e.g. a `127.0.0.1:1`-style connection-refused address, matching
  the pattern `tests/orchestrator/run-discovery.test.ts` already uses for
  its own unreachable-host case) that makes `page.goto()` genuinely throw
  rather than return a 4xx/5xx response, and add a stampede-replay case
  proving `replay.ts`'s catch block records it as `ok: false` with a real
  measured duration.
- Extend `tests/treeline-adapter.test.ts`'s existing stub test (`"falls
  back to the stub when treeLine is not found"`) with two more assertions:
  `adapter.checkAuthStillValid(...)` rejects with `TreelineUnavailableError`,
  and `adapter.detectAuthWall(page)` behaves correctly against a stub
  instance specifically (not incidentally through the real adapter, which
  is what happens today on a machine with treeLine built — construct the
  stub the same explicit-bad-path way the existing test does, and drive a
  real page through it the way the "against a live browser" describe block
  does). Optionally: a case setting `DROVER_TREELINE_PATH` (via
  `vi.stubEnv`) and asserting it's the path actually used.

### Session 9 — Browser session

- Add one fixture page to `tests/fixtures/site.ts` that throws an uncaught
  JS exception (e.g. `<script>null.foo()</script>` or similar — anything
  that fires Playwright's `pageerror` event rather than going through
  `console.error`), and add a new case to `tests/browser.test.ts` proving
  a `page-error` event lands in the event stream with the exception
  message. (This is a good moment to also double-check the `GAPS.md` entry
  about `page-error` never producing a finding — the new test just needs
  to prove the *event* is captured, not that a finding fires, since that's
  a separate, already-logged question.)
- One case forcing `captureScreenshot` to fail (e.g. an invalid/
  unwritable `dir`, or stub `page.screenshot` to reject if that's easier)
  and asserting it resolves to `undefined` rather than throwing.
- Optional, lower priority: a case proving a `"fill"` action's failure
  still logs the `action-error` event (today only a failing `"click"` is
  tested for this at the `BrowserSession` layer).

### Session 10 — CLI coverage + closing the loop

This is the last session and has two parts.

**Part A — decide the CLI testing approach, then execute it.** Two
options, pick one (this is the one place in this plan where a small,
purely-additive source change is in scope, since there's no way to unit
test un-exported functions):
1. Add `export` to `runCommand`, `analyzeCommand`, `reportCommand`,
   `stampedeCommand`, and `parseConcurrencyLevels` in `src/cli/index.ts`
   (no behavior change), then unit-test each directly with an in-memory
   `DroverDb` and real `runDiscovery`/`runAnalyst`/`buildRunReport` calls
   (or thin fakes, matching how `tests/orchestrator/run-discovery.test.ts`
   already injects a `providerFactory`) — asserting console output shape,
   `--out` file-writing vs. stdout, and the `catch { process.exitCode = 1
   }` wrapping on a thrown error.
2. Leave the file as-is and drive coverage entirely through
   `program.parseAsync(fakeArgv)`, capturing `console.log`/`console.error`
   via `vi.spyOn`. More faithful to real CLI invocation, but slower and
   closer to `smoke-orchestrator.ts`'s existing subprocess-shaped test than
   this repo's usual unit-test style (`TESTING.md`'s Session 3 entry
   explicitly preferred not spawning a subprocess for exactly this
   readability/flakiness reason when it built the golden suite).

At minimum, unit-test `parseConcurrencyLevels` directly regardless of which
option is chosen for the rest (valid comma-separated list, a non-integer
entry, a zero/negative entry) — it's pure and needs no CLI-wiring decision
either way.

**Part B — close the loop on this file.**
- Add `@vitest/coverage-v8` as a real `devDependency` and a `"test:coverage":
  "vitest run --coverage"` script to `package.json`, so a future sweep (or
  CI, if the user wants it gated there — ask, don't assume, same as
  `TESTING.md`'s own CI-badge precedent) doesn't need to reinstall it
  ad hoc.
- Re-run the full suite with coverage once Sessions 1–9 have landed and
  record the new headline numbers at the top of this file (or, if every
  item above is closed, fold a short closing note into `TESTING.md`'s own
  decisions log the way its Sessions 1–4 did, and mark this file
  historical rather than deleting it — matching this repo's existing
  convention of keeping build-history files around rather than removing
  them).
- `TESTING.md`'s own "18 files / 118 tests" snapshot is already stale as of
  this sweep (currently 24 files / 173 tests, from Sessions 5–7's report/
  stampede work landing after that snapshot was written) — worth a
  one-line refresh while this file is being touched anyway, though that's
  a documentation nit, not a coverage gap.
