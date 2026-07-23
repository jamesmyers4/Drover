# Drover Build State
Current session: 1 — DONE
Next step: Start Session 2 — build `src/browser/` (Playwright wrapper emitting ActionEvents to SQLite) and `src/treeline/adapter.ts`; look for treeLine as a sibling directory or installed package first, stub it if not found.

## Decisions log
- 2026-07-23 S1: Linter is **Biome** (not ESLint) — single fast tool, format + lint in one, zero plugin sprawl.
- 2026-07-23 S1: `better-sqlite3` pinned to **^12.11.1**, not v13 — v13 dropped prebuilt binaries (install script is bare `node-gyp rebuild`) and this machine has no MSVC C++ toolchain; v12 ships prebuilds for Node 24 (ABI 137). Do not bump to v13 unless a toolchain appears.
- 2026-07-23 S1: Both finding tables carry a `match_key TEXT NOT NULL` column and `finding_status_history` is keyed `(match_key, run_id)` — gives status history a stable cross-run join key from day one. The *computation* of the key (planned: type + normalized route + target identifier) is Session 4's job; until then callers supply it.
- 2026-07-23 S1: IDs are UUIDs (`newId()` in `src/db/database.ts`); callers supply IDs for all entities *except* action events — `insertActionEvent` generates and returns the id (the `ActionEvent` interface from CONTEXT.md has no id field, and findings need the id to reference the event).
- 2026-07-23 S1: Package is ESM (`"type": "module"`), Node >=20, strict tsconfig with `exactOptionalPropertyTypes` — DB read helpers omit optional fields rather than returning `undefined`-valued keys, so round-trips are `toEqual`-exact.
- 2026-07-23 S1: Session-frequency run dimension named `sessionsPerPersonaPerWeek`; run statuses `running|completed|budget-stopped|crashed`, session statuses `running|completed|hard-stopped|budget-capped` — CONTEXT.md implied but didn't enumerate these.
- 2026-07-23 S1: In-session finding types enumerated as `console-error|http-failure|action-budget-exhausted|hard-stop`; cross-session as `duplicate-label|repeated-stumble-route|slow-checkpoint|recurring-dead-end` (from CONTEXT.md prose). Enforced by CHECK constraints — extending the list means a new migration.

## Pending user input
- Horse Haven staging URL/credentials — not needed until Session 2's smoke script (which may use any public/local page) and truly blocking only in Session 9.
- treeLine repo location — Session 2 will look for a sibling directory or installed package; ask the user if not discoverable.

## What exists now
- Compiling ESM TypeScript package (`npm run build` / `typecheck` / `test` / `lint` all pass).
- `src/types/` — PersonaArchetype, WeightedGoal, Goal, Checkpoint, DomainPack, ActionEvent (verbatim from CONTEXT.md), plus InSessionFinding, CrossSessionFinding, FindingStatusRecord, SimConfig, Run, PersonaSession.
- `src/db/` — better-sqlite3 layer (`DroverDb`) with versioned migrations for runs, sessions, action_events, in_session_findings, cross_session_findings, finding_status_history (open-run count = `countOpenRuns(matchKey)`), WAL mode, FKs on, CHECK constraints on statuses/types.
- `tests/db.test.ts` — 9 tests: clean migration on empty DB, round-trip of every entity, status-history counting, FK/CHECK enforcement.
- Tracking files: GAPS.md, TREELINE-GAPS.md (both empty with purpose headers), this file.

## Session history
- S1 2026-07-23: DONE — repo scaffold, all core types, SQLite layer with migrations, 9 passing tests.
