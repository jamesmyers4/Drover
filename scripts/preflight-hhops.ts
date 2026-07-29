/**
 * Preflight check for packs/horse-haven-ops/, run before spending any real LLM budget
 * against it.
 *
 * Exists because of two real incidents, not a hypothetical risk: GAPS.md's 2026-07-28
 * EADDRINUSE entry (a stale app-server process kept serving traffic against the wrong
 * database container, and nothing noticed) and its 2026-07-29 stale-credential entry
 * (packs/horse-haven-ops/domain-pack.ts's hardcoded TEST_VOLUNTEER_ID/TEST_CHECKIN_CODE
 * outlived a container reseed, so three real discovery runs executed against a check-in
 * code that no longer belonged to any real volunteer row — reported as a product bug,
 * when it was actually a stale fixture). Both were only caught after the fact, by a human
 * noticing the results didn't make sense.
 *
 *   npm run preflight:hhops
 *
 * Exits non-zero with a specific, actionable message on the first failed check. Makes no
 * writes anywhere — pure read-only verification, safe to run any number of times.
 *
 * What this does NOT fully rule out: if a *stale* app-server process is still bound to
 * port 3000 from an earlier session (the literal EADDRINUSE scenario), and it happens to
 * be pointed at a database that also has a matching TEST_VOLUNTEER_ID row (e.g. the same
 * container, just an old server process), this script's checks can still pass while the
 * server-under-test isn't actually the one you just started. That specific case still
 * needs the manual `netstat -ano | grep ":3000"` step in ENVIRONMENT.md's Phase 3 — this
 * script complements that check, it doesn't replace it.
 */
import "dotenv/config";
import { Client } from "pg";
import domainPack, { TEST_CHECKIN_CODE, TEST_VOLUNTEER_ID } from "../packs/horse-haven-ops/domain-pack.js";
import simConfig from "../packs/horse-haven-ops/sim.config.js";

function fail(message: string): never {
  console.error(`[preflight] FAIL: ${message}`);
  process.exit(1);
}

function redact(url: string): string {
  return url.replace(/:\/\/[^@]*@/, "://***:***@");
}

async function main() {
  console.log(`[preflight] domain pack: ${domainPack.appName}`);
  const targetBaseUrl = simConfig.targetBaseUrl;
  console.log(`[preflight] target: ${targetBaseUrl}`);

  // 1. The app server is actually reachable and looks like the real kiosk page.
  let kioskHtml: string;
  try {
    const res = await fetch(`${targetBaseUrl}/kiosk`);
    if (!res.ok) {
      fail(`GET ${targetBaseUrl}/kiosk returned HTTP ${res.status} — is the app server up?`);
    }
    kioskHtml = await res.text();
  } catch (err) {
    fail(
      `could not reach ${targetBaseUrl}/kiosk (${(err as Error).message}). ` +
        "Nothing is listening on the target port, or the app hasn't been started yet — " +
        "see ENVIRONMENT.md Phase 3.",
    );
  }
  if (!kioskHtml.includes("Check In / Out")) {
    fail(
      `${targetBaseUrl}/kiosk responded but didn't contain the expected "Check In / Out" ` +
        "marker text — this may not be the volunteer-ops kiosk page (wrong app or wrong port).",
    );
  }
  console.log("[preflight] OK  kiosk page reachable and looks right");

  // 2. HHOPS_TEST_DATABASE_URL points at a local, disposable container — never a real
  //    deployment. See ENVIRONMENT.md's "What went wrong once" section: this exact mistake
  //    already happened once.
  const dbUrl = process.env.HHOPS_TEST_DATABASE_URL ?? "";
  if (!dbUrl) {
    fail("HHOPS_TEST_DATABASE_URL is not set in .env");
  }
  if (!dbUrl.includes("localhost")) {
    fail(
      `HHOPS_TEST_DATABASE_URL does not point at localhost (got "${redact(dbUrl)}"). ` +
        "Refusing to proceed — this must never be a real Neon connection string.",
    );
  }
  console.log(`[preflight] OK  HHOPS_TEST_DATABASE_URL points at localhost (${redact(dbUrl)})`);

  // 3. The pack's hardcoded test volunteer actually exists in that database, with the
  //    check-in code the pack expects — the actual bug this script exists to catch.
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const result = await client.query('SELECT id, "checkInCode" FROM "Volunteer" WHERE id = $1', [
      TEST_VOLUNTEER_ID,
    ]);
    if (result.rowCount === 0) {
      fail(
        `no Volunteer row with id "${TEST_VOLUNTEER_ID}" exists in this database. ` +
          "The container was likely reseeded since domain-pack.ts's TEST_VOLUNTEER_ID/" +
          "TEST_CHECKIN_CODE constants were last updated — re-run `npm run drover:seed-volunteer` " +
          "in volunteer-ops and update those two constants to match its printed output.",
      );
    }
    const row = result.rows[0] as { id: string; checkInCode: string };
    if (row.checkInCode !== TEST_CHECKIN_CODE) {
      fail(
        `Volunteer "${TEST_VOLUNTEER_ID}" exists but its checkInCode ("${row.checkInCode}") ` +
          `doesn't match domain-pack.ts's TEST_CHECKIN_CODE ("${TEST_CHECKIN_CODE}"). ` +
          "Update the constant to match.",
      );
    }
  } finally {
    await client.end();
  }
  console.log("[preflight] OK  test volunteer exists in the target database with the expected check-in code");

  console.log("[preflight] all checks passed — safe to run `drover run` against packs/horse-haven-ops/");
  console.log(
    '[preflight] reminder: this does not fully rule out a stale server process — see this ' +
      "script's own header comment, and ENVIRONMENT.md Phase 3's netstat check.",
  );
}

main().catch((err) => {
  console.error("[preflight] unexpected error:", err);
  process.exit(1);
});
