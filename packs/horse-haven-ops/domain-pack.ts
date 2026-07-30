import { clerk, clerkSetup } from "@clerk/testing/playwright";
import type { Browser } from "playwright";
import { Client } from "pg";
import { firstTimerCautious, powerUserMobile } from "../../examples/archetypes.js";
import type { DomainPack, DomainPackStorageState } from "../../src/types/index.js";

// Exported (not just module-local) so scripts/preflight-hhops.ts can verify these still
// match a live reseed of the target database before any run spends real LLM budget against
// them — see GAPS.md's 2026-07-29 entry for the incident that made this necessary.
export const TEST_VOLUNTEER_ID = "cms6s1c4f0000rcjof3d4zuj2";
export const TEST_CHECKIN_CODE = "cms6s1c4f0001rcjo5qtch5db";

/**
 * Session 3 (GAPS.md 2026-07-29): volunteer-ops gates everything except /kiosk behind
 * `requireVolunteer()`, real Clerk auth — but every account has `skipPasswordRequirement:
 * true` (no password strategy at all), signed in via @clerk/testing's testing-token
 * mechanism instead, the exact same one volunteer-ops's own Playwright E2E suite uses
 * (tests/e2e/fixtures.ts). `DomainPack.auth`'s generic loginUrl/username/password/CSS-
 * selector shape has no login form to target here at all, so this pack uses
 * `DomainPack.customLogin` instead (src/types/domain-pack.ts).
 *
 * The Clerk user this signs in as is provisioned by volunteer-ops's
 * scripts/seed-drover-test-clerk-volunteer.ts (npm run drover:seed-clerk-volunteer) — a
 * dedicated identity, never volunteer-ops's own tests/e2e/test-users.ts TEST_USERS (those
 * belong to that repo's own E2E-suite container and get wiped by resetTransactionalData()
 * if that suite runs against this container). Unlike TEST_VOLUNTEER_ID/TEST_CHECKIN_CODE
 * above, HHOPS_CLERK_TEST_EMAIL does not need updating on every container reseed: the
 * Clerk user itself lives in Clerk's real hosted instance, not the disposable local
 * Postgres container, so the seed script's find-or-create-by-email always finds the same
 * Clerk user across reseeds — only the local Volunteer row backing it gets recreated.
 */
async function clerkCustomLogin(
  browser: Browser,
  targetBaseUrl: string,
): Promise<DomainPackStorageState> {
  const secretKey = process.env.HHOPS_CLERK_SECRET_KEY;
  const publishableKey = process.env.HHOPS_CLERK_PUBLISHABLE_KEY;
  const emailAddress = process.env.HHOPS_CLERK_TEST_EMAIL;
  if (!secretKey || !publishableKey || !emailAddress) {
    throw new Error(
      "customLogin requires HHOPS_CLERK_SECRET_KEY, HHOPS_CLERK_PUBLISHABLE_KEY, and " +
        "HHOPS_CLERK_TEST_EMAIL to be set in .env — see packs/horse-haven-ops/ENVIRONMENT.md.",
    );
  }

  await clerkSetup({ secretKey, publishableKey, dotenv: false });
  // clerk.signIn's email-address strategy (unlike clerkSetup above) has no options param
  // for the secret key at all — its own source reads process.env.CLERK_SECRET_KEY directly.
  // Confirmed by hitting exactly this in a real run: clerkSetup succeeded with the explicit
  // option, then clerk.signIn itself threw "CLERK_SECRET_KEY environment variable is
  // required for email-based sign-in" a few lines later. Setting the standard-named var
  // here (not relying on it already being set) is the only way to satisfy that lookup.
  process.env.CLERK_SECRET_KEY = secretKey;

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // clerk.signIn requires a page that has already loaded Clerk once before it's called —
    // same precedent volunteer-ops's own tests/e2e/fixtures.ts follows.
    await page.goto(targetBaseUrl);
    await clerk.signIn({ page, emailAddress });
    await page.goto(targetBaseUrl);
    return await context.storageState();
  } finally {
    await context.close();
  }
}

const domainPack: DomainPack = {
  appName: "Horse Haven Ops",
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
    // Authenticated-flow personas reuse the core archetype set (README.md's "Writing a
    // domain pack") rather than inventing pack-specific traits — the kiosk personas above
    // stay pack-local since they're deliberately tailored to a shared-tablet check-in
    // interaction that doesn't map onto the four generic archetypes.
    firstTimerCautious,
    powerUserMobile,
  ],
  goals: [
    {
      id: "kiosk-checkin-toggle",
      description: `Navigate directly to http://localhost:3000/kiosk — the barn kiosk check-in page, which needs no login. Do not sign in or look for a login link; go straight to that URL. Enter the check-in code ${TEST_CHECKIN_CODE}, then submit it to check in or out.`,
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
        "Navigate directly to http://localhost:3000/kiosk — the barn kiosk check-in page, which needs no login. Do not sign in or look for a login link; go straight to that URL. Enter the code ZZZZ99, which does not belong to any real volunteer, then submit it.",
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
    {
      id: "view-dashboard",
      description:
        "After signing in, navigate to the Daily Dashboard at http://localhost:3000/dashboard and review today's animal handling assignments.",
      actionBudget: 4,
      checkpoints: [
        {
          id: "on-dashboard",
          description: "Reached the Daily Dashboard.",
          detector: "url:/dashboard",
        },
      ],
      successCheckpointId: "on-dashboard",
    },
    {
      id: "browse-animals",
      description:
        "Navigate to the Horses list at http://localhost:3000/animals and review the roster.",
      actionBudget: 4,
      checkpoints: [
        { id: "on-animals", description: "Reached the Horses list.", detector: "url:/animals" },
      ],
      successCheckpointId: "on-animals",
    },
    {
      id: "check-feed-board",
      description:
        "Navigate to the Feed Board at http://localhost:3000/feed-board and check today's feeding assignments.",
      actionBudget: 4,
      checkpoints: [
        {
          id: "on-feed-board",
          description: "Reached the Feed Board.",
          detector: "url:/feed-board",
        },
      ],
      successCheckpointId: "on-feed-board",
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
    "first-timer-cautious": [
      { goalId: "view-dashboard", weight: 3 },
      { goalId: "browse-animals", weight: 2 },
      { goalId: "check-feed-board", weight: 1 },
    ],
    "power-user-mobile": [
      { goalId: "browse-animals", weight: 3 },
      { goalId: "check-feed-board", weight: 2 },
      { goalId: "view-dashboard", weight: 1 },
    ],
  },
  dataPolicy: "synthetic-only",
  customLogin: clerkCustomLogin,
  teardown: async (ctx) => {
    const client = new Client({
      connectionString: process.env.HHOPS_TEST_DATABASE_URL,
    });
    await client.connect();
    // CheckIn.createdAt is Prisma's plain `DateTime` (Postgres "timestamp without time
    // zone"), written by Prisma as literal UTC wall-clock digits. Binding JS `Date` objects
    // here instead of ISO strings made node-postgres serialize them as *local* wall-clock
    // time (this machine: America/New_York, UTC-4), so the BETWEEN window silently matched
    // zero rows whenever the local timezone wasn't UTC — found via a real validation run.
    // ISO strings avoid that: Postgres casts a "timestamp without time zone" input string by
    // taking its digits literally and discarding any trailing zone/offset, matching exactly
    // what Prisma wrote.
    const start = new Date(ctx.runStartedAt).toISOString();
    const end = new Date(ctx.runEndedAt).toISOString();
    const result = await client.query(
      `DELETE FROM "CheckIn" WHERE "volunteerId" = $1 AND "createdAt" BETWEEN $2::timestamp AND $3::timestamp`,
      [TEST_VOLUNTEER_ID, start, end],
    );
    await client.end();
    console.log(
      `[teardown] cleared ${result.rowCount} CheckIn row(s) for volunteer ${TEST_VOLUNTEER_ID} between ${start} and ${end}`,
    );
  },
};

export default domainPack;
