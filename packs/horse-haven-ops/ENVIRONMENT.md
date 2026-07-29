# Horse Haven Ops — environment guide

Replaces `KIOSK.md` (repo root, now deleted), which described the same setup before it was proven working end to end. Lives here per the convention this file establishes: **every domain pack targeting a real app gets its own `packs/<app-name>/ENVIRONMENT.md`**, not a root-level doc named after one flow. See `CLAUDE.md`'s Build status section for the pointer to this convention.

## What this is

A guide for standing up a local, throwaway environment for `volunteer-ops` (Horse Haven Ops) and running a real Drover discovery run against it. Proven working 2026-07-28: 24/24 sessions completed, 0 hard-stops, real `CheckIn` rows created, toggled, and correctly torn down (see `GAPS.md`'s 2026-07-28 aria-ref entry and `SESSION-LOG.md`'s matching entry for the fix that got sessions completing at all; see `GAPS.md`'s 2026-07-28 (2)/(3) entries for the dedicated-container migration and a teardown timezone bug found while validating it).

## Why this is scoped to the kiosk flow specifically

Two things remain true about the current state of both repos:

1. **`packs/horse-haven-ops/domain-pack.ts` only covers `/kiosk`.** `DomainPack.auth` exists and is wired (`GAPS.md`'s 2026-07-26 login/storageState entry), so nothing _technically_ blocks extending to `/dashboard`, `/animals`, `/feed-board` anymore — but the pack itself hasn't been extended with real goals/checkpoints for them yet. That's the remaining Session 9 work.
2. **`/kiosk` is still the one route with no auth wall.** `src/app/kiosk/page.tsx`'s own comment: "Deliberately no `requireVolunteer()` — this page is meant for a shared, unauthenticated tablet at the barn." Identified purely by a `checkInCode` string, looked up in `src/lib/checkin.ts`'s `performKioskToggle`.

## Non-negotiable safety rule

Everything in this doc targets a **local Docker Postgres container**, never the real Neon database `npm run dev` normally connects to. Before starting the app server, and again before pointing Drover at it, explicitly print and confirm `DATABASE_URL` resolves to a `localhost` host. If at any point a command's output shows a `neon.tech` hostname, stop.

This isn't a hypothetical — it's a mistake that already happened once. See the "What went wrong once" section below before touching any of this.

## Dedicated container — not shared with volunteer-ops's own test suite

This guide uses `volunteer-ops/docker-compose.drover.yml` (`localhost:5434`, db `volunteer_ops_drover`) — a container built specifically for Drover, fully separate from `docker-compose.test.yml`'s own `localhost:5433`/`volunteer_ops_test` container that `volunteer-ops`'s vitest/Playwright E2E suite uses. Both containers can run simultaneously with zero contention (confirmed during the 2026-07-28 migration validation) — there's no sequencing rule to remember here, unlike the shared-container setup this replaced (`GAPS.md`'s 2026-07-28 (2) entry has the full incident writeup for why that reuse was a real collision risk, not a hypothetical one).

## What went wrong once — read before assuming any of this is already correct

On 2026-07-27, `Drover/.env`'s `HHOPS_TEST_DATABASE_URL` got set to the real Neon connection string (direct, non-pooled) instead of the local container — a genuine mismatch between two different valid-looking plans, not a hallucinated one. The app server for a validation run was built and started per this doc (bound to the local container), but teardown's `DELETE FROM "CheckIn"` was pointed at Neon instead, where it deleted 0 rows both times purely because the synthetic test volunteer never existed there — not because anything was actually configured correctly. No real data was touched, but it was live until caught. Fixed the same day (`HHOPS_TEST_DATABASE_URL` corrected, 8 orphaned rows cleaned from the actual local container they were sitting in). Reasoning for future reference: **`HHOPS_TEST_DATABASE_URL` must always match whatever database the app server Drover is pointed at is actually bound to at the time — nothing enforces that automatically, it has to be checked by hand every time this environment is stood up.**

A second, independent mistake happened during the 2026-07-28 dedicated-container migration itself: `npm run start` silently failed with `EADDRINUSE` (a stale `next start` process from earlier the same day was still bound to port 3000, against the *old* 5433 container) — and the very next command run (`curl .../kiosk`, then a full Drover discovery run) happily succeeded against that stale, wrong-database server, since nothing checks which app instance is actually listening on the target port. **Always check what's already listening on port 3000 before trusting a fresh `npm run start` is the one being tested** — `netstat -ano | grep ":3000"` (or PowerShell `Get-Process -Id <pid>`) before Phase 3, not just after.

## Phase 0 — locate both repos, verify tooling

```bash
cd ~/volunteer-ops && git log --oneline -3 && git status
find ~ -maxdepth 4 -iname "drover" -type d 2>/dev/null
docker --version && docker ps
node --version
echo "ANTHROPIC_API_KEY set: ${ANTHROPIC_API_KEY:+yes}"
```

If `ANTHROPIC_API_KEY` isn't set, stop and ask the user rather than proceeding — every session's model call fails without it.

## Phase 1 — stand up the dedicated Drover test database

```bash
cd ~/volunteer-ops
cp .env.drover.example .env.drover   # only if .env.drover doesn't already exist
npm run drover:db:up
npm run drover:db:migrate
npm run drover:db:seed
```

Verify the seed landed — expect `WorkType` to include a row named `"Regular Shift"` with `active: true`, at least one `ShiftTemplate`, and a `FarmSettings` singleton. `performKioskToggle` needs all three.

## Phase 2 — create the dedicated test volunteer

Use the real, committed script — not an ad hoc one-liner:

```bash
npm run drover:seed-volunteer
```

(`scripts/seed-drover-test-volunteer.ts` — idempotent, finds-or-creates by name, loads `.env.drover` explicitly, and refuses to run unless `DATABASE_URL` contains `localhost`. Never reuses `tests/e2e/test-users.ts`'s shared `TEST_USERS` — those get wiped by `resetTransactionalData()` if the E2E suite ever runs against the *other* container.)

Record the printed `id` and `checkInCode` — they go into `packs/horse-haven-ops/domain-pack.ts`'s `TEST_VOLUNTEER_ID`/`TEST_CHECKIN_CODE` constants in the Drover repo (already set from the 2026-07-28 dedicated-container run; only needs updating if the container gets wiped and reseeded — the ids change every time, since the seed script's find-or-create is keyed by name, not a fixed id).

## Phase 3 — boot the app against the test DB

```bash
cd ~/volunteer-ops
netstat -ano | grep ":3000"   # confirm nothing already listening — see "What went wrong once" above
npx dotenv -e .env.drover -e .env -- node -e "console.log('DATABASE_URL:', process.env.DATABASE_URL)"
```

Confirm this prints `localhost:5434`, not a `neon.tech` host and not `:5433` (that's the *other* container). Then:

```bash
npm run build
npx dotenv -e .env.drover -e .env -- npm run start &
sleep 5
netstat -ano | grep ":3000"   # confirm the PID now listening is the one just started
curl -s http://localhost:3000/kiosk | grep -o "Check In / Out" && echo "kiosk reachable, no auth wall"
```

## Phase 4 — verify Drover is ready

```bash
cd ~/drover
npm install
npx playwright install chromium
npm run build
npm test
```

Confirm `HHOPS_TEST_DATABASE_URL` in `.env`:

```bash
grep HHOPS_TEST_DATABASE_URL .env
```

Must read `postgresql://postgres:postgres@localhost:5434/volunteer_ops_drover`. If it shows a `neon.tech` host or port `5433`, **stop and fix it before running anything** — see "What went wrong once" above.

## Phase 5 — run the pipeline

```bash
npm run drover -- run packs/horse-haven-ops/domain-pack.ts --config packs/horse-haven-ops/sim.config.ts --out runs/hhops-N.sqlite
npm run drover -- analyze <run-id> --db runs/hhops-N.sqlite
npm run drover -- report <run-id> --db runs/hhops-N.sqlite --out runs/hhops-N-report.md
```

## Phase 6 — cleanup

The test DB is `tmpfs`-backed and fully disposable:

```bash
cd ~/volunteer-ops
npm run drover:db:down
```

Stop the app server. Nothing here touches the real Neon database, any real volunteer's data, or `volunteer-ops`'s own `docker-compose.test.yml` container at any point — confirmed by the same checks in Phase 3 and Phase 4.

---

## Out of scope, flagged for later

Everything behind `requireVolunteer()` — dashboard, animals, feed board, training, admin — stays untested by this run. `DomainPack.auth` is wired (`GAPS.md`, 2026-07-26) but `packs/horse-haven-ops/domain-pack.ts` hasn't been extended with real goals/checkpoints for any of those routes yet. That's the actual remaining Session 9 scope, separate from the dedicated-container work `GAPS.md`'s 2026-07-28 entries closed.
