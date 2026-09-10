# Reference run — what this fixture actually demonstrated

CTS.md Soak Session 8's own deliverable: a plain-language account of a real
Soak run — execution, both analysis passes, and the report — against
`examples/soak-toy-fixture`, so it's credible to say "the engine works end
to end" before Shenny's own session builds a real blueprint against it
(ADR 0010). Reproduce it yourself with:

```
npm run smoke:soak
```

## What ran, and what was scripted vs. real

- **Execution (Soak Sessions 1-4):** fully real HTTP dispatch against a real
  local fixture server (`examples/soak-toy-fixture/site-server.ts`) — every
  turn's scheduling, pacing, budget check, and HTTP request/response is the
  genuine `runSoak` engine, not simulated. The one scripted piece: this
  build environment has no local Ollama install (same gap `GAPS.md` already
  tracks for the actor tier and Grader), so the variation step used
  `ScriptedSoakContentProvider` instead of a real driver model — flagged
  explicitly by the script's own console output, not silently substituted.
  The blueprint's `driverProvider`/`driverModel` fields are a fully valid
  real-Ollama reference regardless of what this particular run used.
- **Cross-turn analysis (Soak Session 6):** fully real — a genuine Anthropic
  Batch API call (`claude-sonnet-5`), cost $0.0121.
- **Grader analysis (Soak Session 5 adapter + Grader):** fully real — a
  genuine `runGrading()` call and real `grader.sqlite` writes, but
  Layer-1-only by the blueprint's own `graderIntegration.layers` config
  (Layers 2-7 all need a real judge model, which this environment doesn't
  have installed). A real target's own blueprint should enable the full
  Layers 1-7 once real judges are available.
- **Report (Soak Session 7):** fully real — reads only the two SQLite files
  produced above.

## Run summary

- **Run:** `21828cac-f269-4fe5-a2dc-10416105657d`, status `completed`, ran
  for about 92 seconds (`maxDurationHours` was deliberately short for a
  quick reference run — see `blueprint.ts`'s own doc comment).
- **17 turns dispatched** — 9 backbone (`/api/entries`), 8 messageAnalysis
  (`/api/message-analysis`).
- **Execution cost:** $0.0000 (the fixture app isn't billed; no
  `costPerCallUsd` configured — this blueprint validates the scheduler/
  budget mechanics, not cost accounting).

## The two planted behaviors, both caught for real

- **The periodic backbone failure fired exactly as designed:** the fixture
  fails every 5th `/api/entries` call. The reference run's 5th backbone call
  (`entryCount: 5`) returned a real HTTP 500, recorded as the run's one
  `explicit-error` turn and surfaced correctly in the report's
  "Explicit-error clusters" table.
- **The simulated per-period cap fired exactly as designed:** the fixture
  allows 5 `/api/message-analysis` calls before returning 429 to every call
  after that. Of the 8 messageAnalysis turns the scheduler attempted (the
  blueprint's own `PipelineBudget.maxCallsPerRun` is 8, deliberately higher
  than the fixture's real cap of 5, so the *target's own gating* — not the
  client-side budget — is what actually stops it), calls 6-8 got real 429s
  from the fixture. All three were correctly recorded as `gatedCount`, not
  `explicitErrorCount` — ADR 0006's "402/429 is expected gating, not an
  error" distinction, proven against a real target response.

## What the real cross-turn pass found

Five findings, all real (no `ScriptedCrossTurnProvider` involved in this
run's actual analysis — a real key was present):

1. **`drift` (medium) — genuinely emergent, not planted.** The model
   noticed every `/api/message-analysis` response returns
   `toneEval: "neutral"` regardless of the input's actual emotional content
   (anxious, upbeat, calm, a follow-up request all got the same verdict) —
   a real, honest catch of the fixture's own static/non-functional
   response, found by the model's own reasoning, not something this
   session deliberately engineered into the fixture.
2. **`recurring-error-cluster` (medium)** — correctly grouped the three
   429s (sequences 12, 14, 16) as one shared root cause rather than three
   separate incidents.
3. **`disagreement` (low)** — a lower-confidence, honestly-hedged
   observation about backbone `entryId` sequencing next to the 500 error;
   worth noting this one is weaker than the other findings, not a clean
   catch — included here for an accurate account, not cherry-picked results.
4-5. **`timing-anomaly` × 2 (medium each)** — the deterministic half of the
   pass (no LLM involved) flagged both lanes' response-time tails
   independently (backbone p99/p50 5.3x, messageAnalysis 6.3x) — real
   `percentile()` math over real recorded `responseTimeMs` values.

## What the real Grader pass found

All 17 turns became Cases (rubric `entry-shape`, a single `is-object`
boolean Check) and all 17 passed Layer 1 — expected, since every recorded
response (including the 500 and 429 error bodies) is itself a well-formed
JSON object; Layer 1 checks structural shape, not semantic correctness.
Zero escalations (Layers 4-7 weren't enabled this run, per the blueprint's
own Layer-1-only config).

**A real bug this run caught before the fixture even existed as a public
example:** the first reference-run attempt used a `ScriptedSoakContentProvider`
sized too small for the combined backbone + messageAnalysis turn count,
which produced several genuine "variation failed" turns with no
`responsePayload` — and those turns, fed into `turnToCase` unfiltered,
violated a real `NOT NULL` constraint on Grader's own `cases.output_json`
column (`SQLITE_CONSTRAINT_NOTNULL`). This was a real latent bug in
`runSoakAnalysis`'s Grader integration, not a fixture-specific issue: any
real target's soak run can produce turns with no response (a variation
failure, a dispatch failure), and none of those have anything for a rubric
to judge. Fixed in `src/soak/analyze.ts` — `loadCases` now filters out
turns with no `responsePayload` before mapping them through `turnToCase` —
with a regression test locking it in
(`tests/soak/analyze.test.ts`). This is exactly the kind of gap Session 8's
own stop condition exists to surface before Shenny's session builds against
this engine.

## Reproducing this run

```
npm run smoke:soak
```

Needs `ANTHROPIC_API_KEY` set (via `.env` or the environment) for the real
cross-turn pass — without one, the script falls back to an empty scripted
cross-turn provider and says so explicitly (same pattern
`scripts/smoke-analyst.ts` already established), while the deterministic
timing-anomaly half and the Layer-1-only Grader pass still run for real
either way.
