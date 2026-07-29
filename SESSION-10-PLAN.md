# SESSION-10-PLAN.md — Audit findings and validation roadmap (2026-07-29)

**Read this before doing anything else this session, alongside `CLAUDE.md`/`SESSION-LOG.md`/`GAPS.md`.** This is a forward-looking plan written after auditing the repo's current state, `runs/`'s actual artifacts, and the `volunteer-ops` sibling repo. It exists because the user asked for a written breakdown of "what's next" that a future Claude Code session can execute from cold, without re-deriving the investigation below.

## How to use this document

Each numbered session below is **independent, scoped, and ends with a hard stop**:

- **Do not commit at the end of a session.** Leave changes staged/unstaged for the user to review. The user reviews real-money LLM run output and infra changes by hand before they become permanent.
- **Do not proceed to the next numbered session in the same sitting**, even if it seems like a natural continuation. Stop, summarize what happened (especially real dollar cost and any findings), and wait for the user's go-ahead.
- **Do not treat this doc as authoritative background silently.** If something below turns out to be stale (container state, credential ids, file paths), that's expected — infra drift is the exact problem Session 1 addresses. Verify before acting.
- Sessions are ordered by dependency, not by importance — Session 1 is cheap and unblocks trustworthy results from everything after it.

---

## Audit summary — where things actually stand

**Build**: Sessions 1–8 complete, 229 tests passing, `tsc` clean (verified 2026-07-29). Not in question.

**Real-model validation**: A real `ANTHROPIC_API_KEY` has been exercised for real, multiple times, against a local `volunteer-ops` checkout — but **only against the `/kiosk` flow**, and **only against a local Docker Postgres container**, never the real `volunteer.horsehaventn` staging target (still blocked on staging URL/credentials, per `CLAUDE.md`'s Build status section — unchanged by this audit).

**Three real discovery runs exist in `runs/`** from the 2026-07-28 session (`hhops-drover-container-1/2/3.sqlite`), all 24/24 sessions completed, 0 hard-stops. But:

| Run | Started (UTC) | Actor cost | Analyst cost | Report generated? | Findings |
|---|---|---|---|---|---|
| `hhops-drover-container-1` | Jul 28 22:50 | $0.1875 | $0.0249 | yes | **All 16/16** `kiosk-checkin-toggle` sessions failed — "Code not recognized," never reached the success checkpoint. 9/16 also hit `net::ERR_ABORTED` on the POST. |
| `hhops-drover-container-2` | Jul 29 00:17 | $0.1479 | **never run** | **no report exists** | Unknown — data sits un-analyzed in the sqlite file. |
| `hhops-drover-container-3` | Jul 29 00:53 | $0.1484 | $0.0170 | yes | `repeated-stumble-route` — POST /kiosk intermittently `net::ERR_ABORTED` on the invalid-code goal. |

This matches what the user described ("the first time it failed pretty early on," "I don't recall seeing any results from those runs") almost exactly: run 1 failed its actual goal on every single session, and run 2's results were never surfaced because `drover analyze`/`drover report` were never invoked against it.

### The likely root cause — and why these findings shouldn't be trusted yet

`packs/horse-haven-ops/domain-pack.ts` hardcodes `TEST_VOLUNTEER_ID`/`TEST_CHECKIN_CODE` as literal strings, sourced from whatever the Postgres seed script most recently printed. Tracing git history against the run timestamps:

- Commit `ee8e052` (Jul 28, 19:03 UTC) set the pack to volunteer id `cms4wifg...`.
- **Runs 1, 2, and 3 all executed between 19:03 UTC and the next credential change** — i.e., all three used `cms4wifg...`.
- Commit `9a656e3` (Jul 29, 01:09 UTC — **after all three runs**) changed the pack to a *different* volunteer id, `cms57nsxa...`.

A volunteer id only changes when the dedicated Drover Postgres container gets torn down and reseeded (`drover:db:down` → `drover:db:up` → `drover:db:seed` → `drover:seed-volunteer`; the seed script's find-or-create is keyed by name, not a fixed id — see `packs/horse-haven-ops/ENVIRONMENT.md` Phase 2). `GAPS.md`'s 2026-07-28 (2)/(3) entries document exactly this kind of container churn happening mid-session while chasing the `EADDRINUSE`/timezone bugs that same day. The straightforward read: **the container got reseeded at some point between commit `ee8e052` and commit `9a656e3`, but the pack wasn't updated to match until after runs 1–3 had already executed against a check-in code that no longer belonged to any real volunteer row.** That would produce exactly what run 1 shows — universal "Code not recognized" failures on a goal that's supposed to succeed — as a **stale test-fixture artifact, not a confirmed Horse Haven Ops product bug.**

The `net::ERR_ABORTED` findings (run 1's 9/16, run 3's flaky subset) are less clearly explained by this alone — an aborted POST is a different failure shape than a rejected code — and could still be a real backend issue (e.g. a Server Action racing with something, or the app server getting restarted mid-run during the same debugging session, per `GAPS.md`'s EADDRINUSE entry). **This is exactly the kind of thing Session 2 below needs to re-run cleanly to resolve** — right now it's genuinely ambiguous, and reporting it to the Horse Haven Ops team as-is risks sending a false bug report.

Corroborating: `docker ps` right now shows no container on port 5434 (the dedicated Drover container) — it was torn down at the end of the last session, as `ENVIRONMENT.md` Phase 6 instructs. `.env`'s `HHOPS_TEST_DATABASE_URL` and `domain-pack.ts`'s constants currently agree with each other (both reference the `cms57nsxa...` generation) — but **that agreement has never actually been run against**. No discovery run exists yet using the current, checked-in credential pair.

### The structural gap behind both incidents

Two real incidents now on record (`GAPS.md`'s EADDRINUSE entry, and this audit's stale-credential finding) share the same shape: **nothing in the pipeline verifies that the environment Drover is about to spend real LLM budget testing is actually the environment the pack's hardcoded constants describe.** Both were only caught after the fact, by a human (or agent) noticing the results didn't make sense. This is worth fixing once, generically, rather than just re-running more carefully by hand each time — see Session 1.

---

## Cost basis for future budget ceilings

Actor cost across the three real 24-session kiosk-only runs: $0.1875, $0.1479, $0.1484 → **~$0.0067–0.0078/session, call it $0.01/session with margin.** Analyst cost for a single-chunk (≤25 session) run: ~$0.017–0.025 flat, call it **$0.03/chunk of ≤25 sessions** with margin. These are for a *small* domain pack (2 goals, one route). A broader pack (Session 3 below) will have a longer static prompt block — prompt caching should keep the marginal per-session cost close to the same number, but that assumption needs to be confirmed at small scale before trusting it at large scale (see Session 4's staged-budget approach).

Formula for a given `sessionCount`:

```
runCeilingUsd      ≈ sessionCount × $0.01 × 1.5 (safety margin)
analystCeilingUsd  ≈ ceil(sessionCount / 25) × $0.03 × 1.5
```

Example: `orgSize 4 × 3 weeks × 2/week = 24 sessions` (the existing config) → ~$0.36 actor, ~$0.05 analyst. The existing `sim.config.ts` budget ($3 / $1) is already generous headroom for this scale, which is why it's never tripped.

---

## Session 1 — Harden the environment runbook against silent drift

**Status: done, 2026-07-29 — not yet committed, review the diff.** `scripts/preflight-hhops.ts` exists (`npm run preflight:hhops`), wired into `ENVIRONMENT.md` Phase 5, `GAPS.md`'s 2026-07-29 entry updated. Verified the unreachable-server failure path for real (nothing was listening on port 3000 at the time); the credential-mismatch failure path and the full pass-through path are unverified until Session 2's real container stand-up. See `GAPS.md` for the residual gap this doesn't close (a stale-but-matching server process — still needs the manual netstat check).

**Cost: $0.** No LLM calls. Pure engineering/process work against `Drover` and possibly `volunteer-ops`.

**Goal**: make the two failure modes above (wrong server bound to port 3000; pack constants stale against a reseeded DB) fail loudly and immediately, before any run spends LLM budget, instead of surfacing as confusing findings after the fact.

Suggested approach (use judgment — this is the outcome that matters, not the exact shape):

1. A small preflight script — reasonable home is `scripts/preflight-hhops.ts` in this repo, since it needs to read `packs/horse-haven-ops/domain-pack.ts`'s `TEST_VOLUNTEER_ID`/`TEST_CHECKIN_CODE` constants directly. It should, before any `drover run`:
   - Query `HHOPS_TEST_DATABASE_URL` directly for a `Volunteer` row matching `TEST_VOLUNTEER_ID`, and fail loudly (non-zero exit, clear message) if it doesn't exist — this alone would have caught the stale-credential issue instantly instead of burning a full $0.21 run to discover it.
   - Confirm `HHOPS_TEST_DATABASE_URL` resolves to `localhost` (not `neon.tech`) — `ENVIRONMENT.md` already tells a human to check this by hand; encode it instead.
   - Confirm something is actually listening on port 3000 and that a `curl`/fetch of `targetBaseUrl + "/kiosk"` returns the expected marker text — catches the `EADDRINUSE`-stale-server case.
2. Wire it into `packs/horse-haven-ops/ENVIRONMENT.md`'s Phase 5 as a mandatory first step, replacing the current prose-only manual checks in Phases 3/4 where it makes sense to (keep the manual checks too if you think belt-and-suspenders is warranted — this has bitten twice already).
3. Add a `GAPS.md` entry closing this audit's stale-credential finding once the fix exists (there's already a draft entry below in this file's Appendix you can adapt — see "GAPS.md entry to add").

**Stop condition**: preflight script exists, is readable, and you've reasoned through (or dry-run, if the container happens to be up) that it would have caught both known past incidents. Do not run a real discovery run in this session — that's Session 2. Do not commit. Report back what you built and any judgment calls made.

---

## Session 2 — Clean re-validation run + close out run 2

**Cost: ~$0.20 (one fresh discovery run) + ~$0.03 (analyzing the orphaned run 2).** Depends on Session 1 existing (run its preflight first) but can proceed without it if the user says to skip Session 1 — just be extra careful re-verifying credentials/port by hand per `ENVIRONMENT.md` if so.

**Status: done, 2026-07-29 — not yet committed, review the diff and `runs/hhops-4-report.md` / `runs/hhops-drover-container-2-report.md`.** Full results and updated read on runs 1–3 are in `GAPS.md`'s 2026-07-29 "Update" entry — condensed: a clean single-boot run (`hhops-4`) came back with zero findings at all, which rules out a standing pipeline/pack bug; the previously-orphaned run 2 turned out to have one real `net::ERR_ABORTED` finding (1/24 sessions), not zero. Run 1's total (16/16) failure is now best explained by the already-documented EADDRINUSE incident (wrong server, not stale credentials — run 2/3 used the same credentials and mostly succeeded, which rules that theory out). The recurring `net::ERR_ABORTED` noise across runs 1/2/3 but not run 4 is still a genuinely open question, not resolved either way — flagged for Sessions 3/4 to watch for.

**Goal**: get one trustworthy kiosk-flow report, and stop leaving run 2's data un-reviewed.

1. Stand up the dedicated container fresh (`ENVIRONMENT.md` Phases 0–4), run the Session 1 preflight (or the manual checks if Session 1 wasn't done), then run the existing pipeline unchanged: `drover run` → `drover analyze` → `drover report` against `packs/horse-haven-ops/domain-pack.ts` + `sim.config.ts`, output to `runs/hhops-4.sqlite`.
2. Compare its findings against runs 1 and 3:
   - If **no** "Code not recognized"/`ERR_ABORTED` findings appear → confirms the stale-credential hypothesis above. Update `GAPS.md` to mark runs 1/3's findings as explained-away test artifacts, not real bugs (don't delete the history, annotate it — this file's own convention).
   - If the **same or similar** findings reappear on a verified-clean environment → this is now a **confirmed real bug** in Horse Haven Ops' kiosk check-in flow, worth investigating in `volunteer-ops` directly (`src/lib/checkin.ts`, `src/app/kiosk/`) and worth being the headline of the next feedback report to the Horse Haven team.
3. Separately, run `drover analyze` + `drover report` against the existing `runs/hhops-drover-container-2.sqlite` (no re-run needed, the session data is already there) so that run's results actually get reviewed instead of sitting unexamined.
4. Tear down the container per Phase 6 when done, per the existing non-negotiable safety rule.

**Stop condition**: three reports exist (new clean run + the newly-analyzed run 2 + comparison notes against runs 1/3). Present all of it to the user plainly — don't editorialize away an ambiguous result. Do not commit any `GAPS.md`/pack changes without the user reading the reports first.

---

## Session 3 — Extend the domain pack past `/kiosk`

**Cost: engineering time, $0 LLM until a validation run at the end (keep that run small — a handful of sessions, not the full `sim.config.ts` dimensions — just to confirm goals/checkpoints actually work before committing to a bigger pack).**

**Goal**: `/kiosk` is one tiny unauthenticated form — two goals, one route. `DomainPack.auth` has been wired since 2026-07-26 (`CLAUDE.md`'s Orchestrator section) specifically to unlock the rest of the app (`/dashboard`, `/animals`, `/feed-board`, `/training`, `/admin`), but the pack itself was never extended to use it. This is where materially more real feedback is going to come from — a bigger, more realistic app surface, not more sessions against the same one form.

**Real open question to resolve first, before writing any goals**: `SESSION-LOG.md`'s Session 8/prep entries mention volunteer-ops uses **Clerk** for auth on every route except `/kiosk`. `DomainPack.auth`'s shape (`loginUrl` + `username`/`password` + CSS selectors + a `successIndicator`) assumes a conventional same-origin username/password form. Check whether `volunteer-ops` actually exposes a plain form-based login Playwright can drive this way, or whether Clerk's hosted/redirect-based flow makes that unworkable (e.g. it might need a test-mode bypass, a Clerk testing token, or a session cookie injected directly rather than driven through the UI). **Read `volunteer-ops`'s actual login page/Clerk config before assuming `DomainPack.auth` just works here** — this was flagged as "never exercised against a real login" in `GAPS.md`'s 2026-07-26 entry, and this is the first time anything would actually try it for real.

Once auth is confirmed workable (or a workaround identified):

1. Pick 2–4 real flows behind the auth wall worth testing (read `volunteer-ops`'s actual routes/components to ground this in what's really there, not assumptions — `src/app/dashboard`, `/animals`, `/feed-board` etc.).
2. Write real `Goal`/`Checkpoint` pairs for them, following the existing DSL (`url:`/`selector:`/`text:` detectors, per `README.md`'s "Checkpoint detector DSL" section).
3. Extend `teardown` if any of the new goals create data beyond what the existing `CheckIn` cleanup covers.
4. Run a small smoke-scale validation (not the full `sim.config.ts` dimensions) to confirm the new goals/checkpoints actually work mechanically before trusting them at scale.

**Stop condition**: pack extended, small-scale smoke validation done, results (including any Clerk-auth complications hit) reported to the user. Do not commit. Do not run the full-scale cycle — that's Session 4.

---

## Session 4 — The real validation cycle: budget ceiling, run until a bug or budget/time runs out

**Cost: user's call, staged — see below.** This is the session that actually produces the "good feedback for Horse Haven Ops" deliverable the user asked for.

This is what the user described directly: *"put an upper dollar limit... and go out however far we can in time or until we run into a bug."* Don't jump straight to a large speculative ceiling — the cost-per-session assumption above was measured against a 2-goal, 1-route pack; Session 3's broader pack changes the static prompt block size, and prompt caching's effectiveness at that size hasn't been confirmed. Stage it:

1. **Small confirmation tier** — run the extended pack at roughly the existing `sim.config.ts` scale (org 4, 3 weeks, 2/week — same 24 sessions) with a budget ceiling computed from the formula above. Confirm actual spend still lands near $0.01/session with the bigger pack. If it doesn't, recompute the formula before going further.
2. **Scale-up tier(s)** — once the per-session cost assumption holds, increase `orgSize`/`simulatedWeeks`/`sessionsPerPersonaPerWeek` (and/or `concurrencyCap` if wall-clock time matters more than sequential simplicity — see `README.md`'s Concurrency section for the budget-ceiling exactness trade-off that introduces) in successive runs, each with a ceiling computed from the formula, stopping a tier early if it turns up a real, reportable finding worth stopping to look at rather than grinding through the full budget for marginal additional coverage.
3. Run `drover analyze` + `drover report` after each tier. **A report with zero findings is itself informative** (per `CLAUDE.md`'s note that `hasAnalystPass` should be surfaced, not treated as "nothing to report") — don't only stop on a bug, also stop and check in with the user once a tier completes so they can decide whether to fund the next tier.
4. Compile the actual deliverable: a clear summary of what was found, grouped by severity, written in terms the Horse Haven Ops team (not a Drover internals reader) can act on — that's the actual point of this whole exercise.

**Caveat worth stating plainly in the final deliverable**: everything through this plan runs against a local `volunteer-ops` checkout on a disposable Docker Postgres container, not the real `volunteer.horsehaventn` staging deployment (still pending credentials, per `CLAUDE.md`). Findings in application logic likely transfer directly since it's the same codebase; findings about performance/infra characteristics may not.

**Stop condition**: after each budget tier, not just at the end. Do not commit `sim.config.ts` dimension changes or anything else without the user's explicit go-ahead — dollar-spending decisions are the user's call, not a default to proceed on.

---

## Documentation already updated by this audit (2026-07-29)

- `GAPS.md` — new entry documenting the stale-credential hypothesis for runs 1/3 (see the entry dated 2026-07-29).
- `README.md` — status section lightly updated to reflect the real local validation runs that have now happened.
- `CLAUDE.md` — "Next step" pointer updated to reference this file.

## Appendix — GAPS.md entry added

See `GAPS.md`'s 2026-07-29 entry for the full writeup; this file's "Audit summary" section above is the condensed version.
