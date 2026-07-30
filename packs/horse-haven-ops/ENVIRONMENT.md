# Horse Haven Ops — environment guide

Replaces `KIOSK.md` (repo root, now deleted), which described the same setup before it was proven working end to end. Lives here per the convention this file establishes: **every domain pack targeting a real app gets its own `packs/<app-name>/ENVIRONMENT.md`**, not a root-level doc named after one flow. See `CLAUDE.md`'s Build status section for the pointer to this convention.

## What this is

A guide for standing up a local, throwaway environment for `volunteer-ops` (Horse Haven Ops) and running a real Drover discovery run against it. Proven working 2026-07-28: 24/24 sessions completed, 0 hard-stops, real `CheckIn` rows created, toggled, and correctly torn down (see `GAPS.md`'s 2026-07-28 aria-ref entry and `SESSION-LOG.md`'s matching entry for the fix that got sessions completing at all; see `GAPS.md`'s 2026-07-28 (2)/(3) entries for the dedicated-container migration and a teardown timezone bug found while validating it). Extended 2026-07-29/30 (Session 3, `SESSION-10-PLAN.md`) past `/kiosk` to real Clerk-authenticated flows (`/dashboard`, `/animals`, `/feed-board`) via `DomainPack.customLogin` — proven working with a small 4-session smoke run, not yet exercised at the full `sim.config.ts` scale.

## Two identities, two auth mechanisms

`/kiosk` needs no login at all (`src/app/kiosk/page.tsx`'s own comment: "Deliberately no `requireVolunteer()` — this page is meant for a shared, unauthenticated tablet at the barn," identified purely by a `checkInCode` string). Every other route in this app (`/dashboard`, `/animals`, `/feed-board`, `/admin`, ...) requires real Clerk sign-in via `requireVolunteer()` — and Clerk here has no password strategy at all (`skipPasswordRequirement: true`), signed in instead via `@clerk/testing`'s testing-token mechanism, the same one this app's own Playwright E2E suite uses (`tests/e2e/fixtures.ts`). `DomainPack.auth`'s generic loginUrl/username/password/CSS-selector shape has no login form to target for that second mechanism at all — Drover's `domain-pack.ts` uses `DomainPack.customLogin` for it instead (`src/types/domain-pack.ts`; see `GAPS.md`'s 2026-07-29 customLogin entry for the full story, including a real Clerk-integration bug found and fixed while first getting this to work).

This means two separate test volunteers get seeded (Phase 2 below), not one.

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

## Phase 2 — create the dedicated test volunteers

Two separate identities, one per auth mechanism (see above). Both scripts are real, committed — not ad hoc one-liners.

**2a — the Clerk-free kiosk volunteer:**

```bash
npm run drover:seed-volunteer
```

(`scripts/seed-drover-test-volunteer.ts` — idempotent, finds-or-creates by name, loads `.env.drover` explicitly, and refuses to run unless `DATABASE_URL` contains `localhost`. Never reuses `tests/e2e/test-users.ts`'s shared `TEST_USERS` — those get wiped by `resetTransactionalData()` if the E2E suite ever runs against the *other* container.)

Record the printed `id` and `checkInCode` — they go into `packs/horse-haven-ops/domain-pack.ts`'s `TEST_VOLUNTEER_ID`/`TEST_CHECKIN_CODE` constants in the Drover repo. **These need updating every time the container gets wiped and reseeded** — the ids change every time, since the seed script's find-or-create is keyed by name, not a fixed id. Forgetting this step is a real, already-logged incident (`GAPS.md`'s 2026-07-29 stale-credential entry) — `npm run preflight:hhops` (Phase 5) now catches it before any run spends LLM budget, but updating the constants here is still a manual step.

**2b — the Clerk-authenticated volunteer (Session 3, for `/dashboard`/`/animals`/`/feed-board`):**

```bash
npm run drover:seed-clerk-volunteer
```

(`scripts/seed-drover-test-clerk-volunteer.ts` — finds-or-creates a real Clerk user by a fixed email, `drover-authtest@volunteer-ops.example.com`, then upserts a matching `Volunteer` row keyed by `clerkId`. Needs `CLERK_SECRET_KEY` from `.env`, loaded alongside `.env.drover`.) Unlike 2a, **the printed email does not need updating on every reseed** — the Clerk user lives in Clerk's real hosted instance, not the disposable local Postgres container, so find-or-create-by-email locates the same Clerk user every time; only the local `Volunteer` row backing it gets recreated. It should already match `HHOPS_CLERK_TEST_EMAIL` in the Drover repo's `.env` — only update that if you deliberately change the email in the script.

The Drover repo's own `.env` also needs `HHOPS_CLERK_SECRET_KEY` and `HHOPS_CLERK_PUBLISHABLE_KEY` set — copy the values from `volunteer-ops/.env`'s `CLERK_SECRET_KEY`/`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (same dev/test Clerk instance the app itself runs against; this is the one place in this whole setup where Drover's "fully local, disposable" test environment depends on a real external hosted service, since Clerk test-user auth genuinely calls Clerk's real backend API — not a hypothetical risk to flag, just worth knowing this one piece isn't torn-down-and-forgotten the way the Postgres container is).

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

**Run the preflight check first, every time** — `npm run preflight:hhops` (from the Drover repo). It verifies the app server is actually reachable and looks right, `HHOPS_TEST_DATABASE_URL` points at localhost, and `domain-pack.ts`'s `TEST_VOLUNTEER_ID`/`TEST_CHECKIN_CODE` still match a real row in the database that URL points to — exists specifically because both of those have silently gone stale before (see "What went wrong once" above, and `GAPS.md`'s 2026-07-29 entry). It exits non-zero with a specific fix-it message on the first failed check, before any run spends real LLM budget. It does **not** fully rule out a stale app-server process still bound to port 3000 from an earlier session (see the script's own header comment) — the netstat check in Phase 3 above is still the authoritative defense against that specific case; run both.

```bash
cd ~/drover
npm run preflight:hhops
```

Once it passes:

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

As of Session 3, `/dashboard`, `/animals`, and `/feed-board` are covered (goals `view-dashboard`, `browse-animals`, `check-feed-board` in `domain-pack.ts`), authenticated as a single `VOLUNTEER`-role identity. Still untested: `/training`, `/admin`, `/events`, `/checkin` (the volunteer's own self-service check-in, distinct from `/kiosk`), and anything requiring an `ADMIN`/`SHIFT_LEAD`-specific role — the single-`customLogin`-per-run shape (mirroring `auth`'s existing one-credential-per-run limitation, see `src/types/domain-pack.ts`) can't express a pack whose different goals need different roles yet. Extending further is straightforward goal-writing now that both auth mechanisms are wired; a second role would need real design work first.
