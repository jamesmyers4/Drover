# Drover kiosk simulation run — setup & execution guide

## What this is

A runbook for standing up a local, throwaway test environment for `volunteer-ops` (Horse Haven Ops) and executing a real Drover discovery run against it, followed by `drover analyze` and `drover report`. This validates the report structure (`drover report`'s markdown output) against a real multi-session dataset for the first time — previously only exercised against small hand-built fixtures.

## Why this is scoped to the kiosk flow specifically

Two things are true about the current state of both repos, confirmed by reading the source directly, not assumed:

1. **No Horse Haven Ops domain pack exists yet.** Drover's own `README.md` says so explicitly: sessions 1–7 built the engine; the real domain pack for this app was never written.
2. **Drover cannot log in to anything yet.** `src/treeline/adapter.ts` has a `performLogin`/`storageState` capability, but nothing in `src/orchestrator/run-discovery.ts` or the `SimConfig`/`DomainPack` types actually calls it. A persona session hits Clerk's auth wall on `/dashboard`, `/animals`, `/feed-board` — everything that calls `requireVolunteer()` — and stops there.

`/kiosk` is the one real exception. `src/app/kiosk/page.tsx` says so in its own comment: _"Deliberately no requireVolunteer() — this page is meant for a shared, unauthenticated tablet at the barn."_ It's identified purely by a `checkInCode` string, looked up in `src/lib/checkin.ts`'s `performKioskToggle`. No Clerk session needed anywhere in that path.

So: this run exercises the kiosk check-in/out toggle only. That's a real, honest, fully-functional slice of the app — not a token exercise — and it's the only slice Drover can currently reach end to end. Broader coverage (dashboard, animals, feed board) needs the auth wiring built first; that's flagged as a follow-up at the end of this doc, not something to improvise around here.

## Non-negotiable safety rule

Everything in this doc targets a **local Docker Postgres container on port 5433** (`docker-compose.test.yml`), never the real Neon database. Before starting the app server in Phase 2, and again before pointing Drover at it in Phase 4, explicitly print and confirm `DATABASE_URL` resolves to `localhost:5433`. If at any point a command's output shows a `neon.tech` hostname, stop.

---

## Phase 0 — locate both repos, verify tooling

```bash
cd ~/volunteer-ops && git log --oneline -3 && git status
```

Confirm this is clean and matches what you expect from the pull. Then find Drover — it isn't necessarily a sibling of `volunteer-ops`:

```bash
find ~ -maxdepth 4 -iname "drover" -type d 2>/dev/null
```

If nothing turns up, **stop and ask the user for the path** rather than `git clone`-ing a fresh copy — there may be uncommitted local work in an existing checkout, and a second copy would just create confusion about which one is authoritative.

Verify tooling:

```bash
docker --version && docker ps
node --version
npm --version
echo "ANTHROPIC_API_KEY set: ${ANTHROPIC_API_KEY:+yes}"
```

`node --version` should be ≥20 (Drover's `engines` field requires it). If `ANTHROPIC_API_KEY` isn't set, **stop and ask the user** rather than proceeding without it — Phase 5's `drover run` will fail on every session's model call without it, and Phase 5's `analyze` needs it too.

---

## Phase 1 — stand up the test database

In `~/volunteer-ops`:

```bash
cp .env.test.example .env.test
npm run test:db:up
npm run test:db:migrate
npm run test:db:seed
```

Verify the seed actually landed before moving on — don't assume a clean exit code means the data is right:

```bash
npx dotenv -e .env.test -- npx prisma studio --port 5556 &
sleep 2
curl -s http://localhost:5556 > /dev/null && echo "Prisma Studio reachable"
kill %1
```

Or more directly, a one-off count check:

```bash
npx dotenv -e .env.test -- node -e "
const { PrismaClient } = require('./src/generated/prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter });
prisma.workType.count().then(n => { console.log('WorkType rows:', n); return prisma.\$disconnect(); });
"
```

Expect `WorkType rows: 9`. If it's 0, the seed didn't run against the container you think it did — check `.env.test`'s `DIRECT_URL` matches `docker-compose.test.yml`'s exposed port (5433) before doing anything else.

---

## Phase 2 — create a dedicated, Clerk-free test volunteer

`Volunteer.clerkId` is nullable (`String? @unique` in `prisma/schema.prisma`) — this test volunteer never needs a Clerk account at all, since the kiosk flow only looks up `checkInCode`. Do **not** reuse the shared `TEST_USERS` from `tests/e2e/test-users.ts` — those get wiped by `resetTransactionalData()` if the e2e suite ever runs against this same container, and mixing Drover's synthetic check-ins into the same identity as Clerk-backed test users muddies both.

```bash
npx dotenv -e .env.test -- node -e "
const { PrismaClient } = require('./src/generated/prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter });
prisma.volunteer.create({ data: { name: 'Drover Test Volunteer', status: 'ACTIVE' } }).then(v => {
  console.log('id:', v.id);
  console.log('checkInCode:', v.checkInCode);
  return prisma.\$disconnect();
});
"
```

Record both printed values — they go into the domain pack in Phase 4. If this throws instead of printing an id, the migration/seed in Phase 1 didn't fully land; go back and check `WorkType`/`FarmSettings`/`ShiftTemplate` rows exist (`performKioskToggle` needs all three: a `WorkType` named `"Regular Shift"` with `active: true`, a `FarmSettings` singleton, and at least one `ShiftTemplate`) — the standard seed script creates all three, so this should only fail if seeding was incomplete.

---

## Phase 3 — boot the app against the test DB, verify `/kiosk` before Drover touches it

This app needs Clerk env vars to boot at all (`clerkMiddleware()` runs on every matched route via `src/proxy.ts`, even ones that don't call `requireVolunteer()`). Check whether a working `.env` already exists locally:

```bash
test -f ~/volunteer-ops/.env && echo "exists" || echo "missing"
grep -q "CLERK_SECRET_KEY=.\+" ~/volunteer-ops/.env 2>/dev/null && echo "has a value" || echo "empty or missing"
```

If `.env` is missing or the Clerk keys are empty, **stop and ask the user** rather than inventing placeholder keys — a fabricated key will either crash the middleware or silently misbehave in a way that's hard to distinguish from a real app bug once Drover findings start coming in.

If `.env` looks populated, boot the server bound to the test DB, exactly the way `playwright.config.ts`'s own `webServer` already proves works for this app (`.env.test` first, `.env` second — so `.env.test`'s `DATABASE_URL` wins, everything else falls through to `.env`):

```bash
npx dotenv -e .env.test -e .env -- node -e "console.log('DATABASE_URL:', process.env.DATABASE_URL)"
```

Confirm that prints `localhost:5433`, not a `neon.tech` host. Then:

```bash
npm run build
npx dotenv -e .env.test -e .env -- npm run start &
sleep 5
curl -s http://localhost:3000/kiosk | grep -o "Check In / Out" && echo "kiosk reachable, no auth wall"
```

Do a real end-to-end check with the code from Phase 2 before wiring up Drover — if this doesn't work manually, it won't work with an LLM driving it either:

```bash
curl -s -i "http://localhost:3000/kiosk" -X POST -H "Content-Type: application/x-www-form-urlencoded" --data "code=PASTE_CODE_HERE" | head -20
```

Expect a redirect to `/kiosk?result=checked-in&name=Drover+Test+Volunteer&at=...`. If instead you get a redirect to `/kiosk?error=1`, or a 500, stop here — something in Phase 1/2 is off, and it needs fixing before Drover enters the picture at all.

---

## Phase 4 — verify Drover itself is ready

In the Drover repo path found in Phase 0:

```bash
npm install
npx playwright install chromium
npm run build
npm test
```

Expect 173+ passing tests. Then install the one extra dependency this run's teardown hook needs:

```bash
npm install --save-dev pg @types/pg
```

---

## Phase 5 — write the domain pack and sim config

Create `packs/horse-haven-ops/domain-pack.ts` in the Drover repo, substituting the real `id` and `checkInCode` from Phase 2:

```typescript
import type { DomainPack } from "../../src/types/index.js";
import { Client } from "pg";

const TEST_VOLUNTEER_ID = "PASTE_ID_FROM_PHASE_2";
const TEST_CHECKIN_CODE = "PASTE_CODE_FROM_PHASE_2";

const domainPack: DomainPack = {
  appName: "Horse Haven Ops - Kiosk Check-In",
  personas: [
    {
      id: "returning-quick-tap",
      name: "Returning Volunteer, Quick Tap",
      traits: {
        patience: 0.7,
        techSavviness: 0.6,
        deviceType: "tablet",
        familiarity: "veteran",
      },
    },
    {
      id: "new-mistyped-code",
      name: "New Volunteer, Mistyped Code",
      traits: {
        patience: 0.3,
        techSavviness: 0.4,
        deviceType: "mobile",
        familiarity: "new",
      },
    },
  ],
  goals: [
    {
      id: "kiosk-checkin-toggle",
      description: `Go to the barn kiosk check-in page and enter the check-in code ${TEST_CHECKIN_CODE}, then submit it to check in or out.`,
      actionBudget: 4,
      checkpoints: [
        {
          id: "toggled",
          description:
            "Reached the kiosk result screen after submitting the code.",
          detector: "url:result=checked",
        },
      ],
      successCheckpointId: "toggled",
    },
    {
      id: "kiosk-invalid-code",
      description:
        "Go to the barn kiosk check-in page and enter the code ZZZZ99, which does not belong to any real volunteer, then submit it.",
      actionBudget: 4,
      checkpoints: [
        {
          id: "error-shown",
          description: "Kiosk shows the code-not-recognized error message.",
          detector: "url:error=1",
        },
      ],
      successCheckpointId: "error-shown",
    },
  ],
  goalWeightsByPersona: {
    "returning-quick-tap": [
      { goalId: "kiosk-checkin-toggle", weight: 4 },
      { goalId: "kiosk-invalid-code", weight: 1 },
    ],
    "new-mistyped-code": [
      { goalId: "kiosk-invalid-code", weight: 3 },
      { goalId: "kiosk-checkin-toggle", weight: 1 },
    ],
  },
  dataPolicy: "synthetic-only",
  teardown: async (ctx) => {
    const client = new Client({
      connectionString: process.env.HHOPS_TEST_DATABASE_URL,
    });
    await client.connect();
    const start = new Date(ctx.runStartedAt);
    const end = new Date(ctx.runEndedAt);
    const result = await client.query(
      `DELETE FROM "CheckIn" WHERE "volunteerId" = $1 AND "createdAt" BETWEEN $2 AND $3`,
      [TEST_VOLUNTEER_ID, start, end],
    );
    await client.end();
    console.log(
      `[teardown] cleared ${result.rowCount} CheckIn row(s) for volunteer ${TEST_VOLUNTEER_ID} between ${start.toISOString()} and ${end.toISOString()}`,
    );
  },
};

export default domainPack;
```

The teardown deliberately only deletes `CheckIn` rows, nothing else. A kiosk check-in also touches `Shift` (via `findOrCreateShift` in `src/lib/checkin.ts`) and writes `ChangeLog` entries — both left alone on purpose. `Shift` is a shared, date+type-keyed entity, not owned by this one test volunteer; deleting it risks the exact over-deletion problem already flagged in Drover's own `GAPS.md` for this hook. Since it's a throwaway local test DB anyway, leaving harmless `Shift`/`ChangeLog` residue behind costs nothing.

Create `packs/horse-haven-ops/sim.config.ts`:

```typescript
import type { SimConfig } from "../../src/types/index.js";

const config: SimConfig = {
  targetBaseUrl: "http://localhost:3000",
  runDimensions: {
    orgSize: 4,
    simulatedWeeks: 3,
    sessionsPerPersonaPerWeek: 2,
  },
  budget: {
    runCeilingUsd: 3,
    perSessionSoftCapUsd: 0.25,
    analystCeilingUsd: 1,
  },
  modelRouting: {
    actor: { provider: "anthropic", model: "claude-haiku-4-5" },
    analyst: { provider: "anthropic", model: "claude-sonnet-5" },
  },
};

export default config;
```

24 total sessions (4 org members × 3 weeks × 2 sessions/week) — enough to give the report's summary table, per-flow breakdown, and since-last-run reconciliation real multiple-`matchKey` data to be judged against, without meaningful Haiku cost.

---

## Phase 6 — run the pipeline

Make sure the app server from Phase 3 is still running and bound to the test DB, then from the Drover repo:

```bash
export HHOPS_TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5433/volunteer_ops_test"
npm run drover -- run packs/horse-haven-ops/domain-pack.ts --config packs/horse-haven-ops/sim.config.ts --out runs/hhops-1.sqlite
```

Note the printed run id, then:

```bash
npm run drover -- analyze <run-id> --db runs/hhops-1.sqlite
npm run drover -- report <run-id> --db runs/hhops-1.sqlite --out runs/hhops-1-report.md
```

If time and budget allow, run the whole sequence a second time against the same `targetBaseUrl` (new `--out` path, e.g. `runs/hhops-2.sqlite`) — the since-last-run new/still-open/resolved counts in `drover report` only get exercised meaningfully across two runs of the same app, and that's one of the specific things this whole exercise is meant to validate.

---

## Phase 7 — what to check in the report

- **Findings summary table** — readable with a real (if small) set of `matchKey`s? Any surprises from the invalid-code goal (e.g. is a "code not recognized" redirect being misclassified as an `http-failure` finding rather than expected behavior)?
- **Breakdown by flow** — with only two goals here it won't stress the "many goals per finding" concern from the earlier report-structure note much, but it'll show whether the section's shape reads right at all against non-fixture data.
- **Since last run** — only meaningful on the second run; confirm resolved/still-open/new actually reflect what changed.
- **Run metadata** — actual actor/analyst spend vs. the `budget` block, dimensions match what was configured.
- **Evidence appendix** — screenshot paths and event ids resolve to real files, not broken links.

---

## Phase 8 — cleanup

The test DB is `tmpfs`-backed and fully disposable:

```bash
cd ~/volunteer-ops && npm run test:db:down
```

Stop the app server (`kill` the process from Phase 3, or `fg` + Ctrl-C if left in the foreground). Nothing here touches the real Neon database or any real volunteer's data at any point.

---

## Out of scope, flagged for later

Everything behind `requireVolunteer()` — dashboard, animals, feed board, training, admin — stays untested by this run. Reaching it needs `SimConfig`/`DomainPack` extended with real login wiring: calling `treeline/adapter.ts`'s `performLogin` (which already exists and already matches the `TreelineLoginCredentials` shape) and threading the resulting `storageState` through to `BrowserSession` (which already accepts one via `src/browser/session.ts`'s `opts.storageState` — also already there, also unused by the orchestrator). Both halves of the plumbing exist independently; nothing currently connects them. Worth a `GAPS.md`/`SESSION-LOG.md` entry once this run is done, framed as the next real domain-pack-driven session (matching the project's existing "worth revisiting once a real domain pack needs it" pattern already used for the teardown-correlation gap).
