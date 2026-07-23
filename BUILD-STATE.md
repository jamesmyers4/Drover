# Drover Build State
Current session: 2 — DONE
Next step: Start Session 3 — build `src/actor/` (perceive→decide→act LLM loop over `BrowserSession`, structured output, prompt caching, trait-shaped behavior, checkpoint detector DSL, in-session findings with screenshots, budget accounting, provider interface with dataPolicy enforcement).

## Decisions log
- 2026-07-23 S1: Linter is **Biome** (not ESLint) — single fast tool, format + lint in one, zero plugin sprawl.
- 2026-07-23 S1: `better-sqlite3` pinned to **^12.11.1**, not v13 — v13 dropped prebuilt binaries (install script is bare `node-gyp rebuild`) and this machine has no MSVC C++ toolchain; v12 ships prebuilds for Node 24 (ABI 137). Do not bump to v13 unless a toolchain appears.
- 2026-07-23 S1: Both finding tables carry a `match_key TEXT NOT NULL` column and `finding_status_history` is keyed `(match_key, run_id)` — gives status history a stable cross-run join key from day one. The *computation* of the key (planned: type + normalized route + target identifier) is Session 4's job; until then callers supply it.
- 2026-07-23 S1: IDs are UUIDs (`newId()` in `src/db/database.ts`); callers supply IDs for all entities *except* action events — `insertActionEvent` generates and returns the id (the `ActionEvent` interface from CONTEXT.md has no id field, and findings need the id to reference the event).
- 2026-07-23 S1: Package is ESM (`"type": "module"`), Node >=20, strict tsconfig with `exactOptionalPropertyTypes` — DB read helpers omit optional fields rather than returning `undefined`-valued keys, so round-trips are `toEqual`-exact.
- 2026-07-23 S1: Session-frequency run dimension named `sessionsPerPersonaPerWeek`; run statuses `running|completed|budget-stopped|crashed`, session statuses `running|completed|hard-stopped|budget-capped` — CONTEXT.md implied but didn't enumerate these.
- 2026-07-23 S1: In-session finding types enumerated as `console-error|http-failure|action-budget-exhausted|hard-stop`; cross-session as `duplicate-label|repeated-stumble-route|slow-checkpoint|recurring-dead-end` (from CONTEXT.md prose). Enforced by CHECK constraints — extending the list means a new migration.
- 2026-07-23 S2: **treeLine loads via runtime dynamic import, not package.json** — `createTreelineAdapter()` imports `../treeLine/packages/acquire/dist/index.js` (override with `DROVER_TREELINE_PATH`), falls back to a stub that throws `TreelineUnavailableError` for login/seed-resolution and keeps a local password-field heuristic for `detectAuthWall`. Rationale: `@treeline/acquire` is unpublished; a `file:` dep would break `npm install` for adopters without the sibling checkout. See TREELINE-GAPS.md.
- 2026-07-23 S2: Event stream action types — primitives `navigate|click|fill|read-page`, observations `console-error|page-error|http-failure`, plus `action-error` when a primitive throws (attempt is logged with its reasoning, then an `action-error` event, then rethrow — caller decides retry vs hard stop). Observation events carry a synthetic one-sentence `reasoning` with the truncated message; the observed URL/status lives in `target`.
- 2026-07-23 S2: HTTP responses ≥ 400 are logged as `http-failure` events (threshold configurable per session) — log raw, filter later; only 5xx becomes an in-session *finding* in S3.
- 2026-07-23 S2: `fill` values never enter the event log (only the selector) — keeps credentials/PII out of SQLite regardless of what a persona types.
- 2026-07-23 S2: Device emulation presets are pinned in `src/browser/device.ts` (desktop 1280×720, Pixel-7-class mobile, iPad-class tablet) rather than referencing Playwright's device registry by name — stable across Playwright upgrades.
- 2026-07-23 S2: Playwright pinned as a regular dependency (chromium installed via `npx playwright install chromium`); `tsx` devDep powers `npm run smoke`.

## Repo locations (from the user, post-S1)
- **treeLine**: `C:\Users\james\Documents\treeLine` — pnpm workspace, code under `packages/`. Drover consumes `packages/acquire`'s built `dist/` at runtime (see S2 decision).
- **Horse Haven Ops app** (the target): `C:\Users\james\Documents\volunteer-ops` — useful for drafting the domain pack (Session 8) and understanding routes/auth.
- Other sibling repos referenced by CONTEXT.md also live in `C:\Users\james\Documents\` (e.g. `OpenEMR-QA`, `shenny`).

## Pending user input
- Horse Haven staging URL/credentials — smoke ran against the local fixture site instead (by design); creds become truly blocking only in Session 9. `SMOKE_URL=<url> npm run smoke` exercises any live target when available.

## What exists now
- Everything from S1 (types, `DroverDb` SQLite layer, migrations, tracking files).
- `src/browser/` — `BrowserSession` (per-session isolated Playwright context, device emulation from `deviceType`, optional `storageState` auth seeding); action primitives `navigate/click/fill/readPageState`, each emitting a raw-timestamp `ActionEvent` and returning the event id; passive console-error/page-error/HTTP-failure listeners writing into the same event stream; `captureScreenshot` utility (never throws — evidence capture failure must not become a crash), deliberately NOT wired to every action.
- `src/treeline/adapter.ts` — `TreelineAdapter` interface + **real integration** (kind `"treeline"`: `performLogin` → storageState, `checkAuthStillValid`, `resolveSeedUrl` via `resolveSeedUrlWithBrowser`) + stub fallback (kind `"stub"`). Real adapter verified working against the sibling checkout in tests and smoke.
- `tests/fixtures/site.ts` — local fixture site (nav links, form, login page, dashboard, console-error page, 500 endpoint) used by tests and smoke; no network dependency.
- `tests/browser.test.ts` (device mapping + 6 live-browser integration tests) and `tests/treeline-adapter.test.ts` (stub fallback + real-treeLine tests that auto-skip if the sibling `dist/` is missing). 24 tests total, all passing with the real adapter.
- `npm run smoke` — hardcoded ~11-action sequence against the fixture site (or `SMOKE_URL`); writes run/session/13 events to `runs/smoke.sqlite`, prints per-type event counts, captures one screenshot, reports adapter kind and auth-wall detection.

## Session history
- S1 2026-07-23: DONE — repo scaffold, all core types, SQLite layer with migrations, 9 passing tests.
- S2 2026-07-23: DONE — browser harness (`BrowserSession` + device emulation + observation listeners + screenshot util), treeLine adapter with real `@treeline/acquire` integration (stub fallback), fixture site, smoke script writing real events to SQLite; 24 tests passing.
