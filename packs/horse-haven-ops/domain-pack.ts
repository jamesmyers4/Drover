import type { DomainPack } from "../../src/types/index.js";
import { Client } from "pg";

const TEST_VOLUNTEER_ID = "cms57nsxa0000wwjockfaubgy";
const TEST_CHECKIN_CODE = "cms57nsxa0001wwjofu4x2r16";

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
