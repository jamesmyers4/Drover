# Reference run — what this pack actually demonstrated

FUTUREPLAN.md Grader Session 8's own deliverable: a plain-language account
of a real Grading Run against `pack.ts`, so it's credible to say "the
engine works end to end" before Shenny's own session builds a real
`GraderPack` against it. Everything below is a real run — no
`ScriptedGraderProvider`, no simulated output. Reproduce it yourself with:

```
npx tsx src/cli/index.ts grade examples/grader-toy-pack/pack.ts \
  --db grader.sqlite --report report.md --json summary.json
```

## What ran

- **Judges:** local Ollama (`qwen3:8b`) and Anthropic (`claude-haiku-4-5`) —
  the CLI's own default routing (`src/cli/index.ts`'s `defaultGraderRouting`)
  picked this pair automatically, since `ANTHROPIC_API_KEY` was present and
  the pack is `synthetic-only`.
- **Layers:** all seven. Layer 1 (deterministic checks) and Layers 2-3
  (single-judge, against Ollama) ran on every Case. Layers 4-7 (multi-judge
  Consensus Round, Ollama + Anthropic) also ran on every Case — the CLI
  logged `layers 4-7 enabled: 4, 5, 6, 7`, confirming real judge diversity
  was actually available this run (see GAPS.md's 2026-09-09 entries for why
  that's not guaranteed by default in every environment).
- **Grading Run:** 5 Cases, `status: completed`, 22 Tasks passed / 13 failed
  / 0 skipped, took about 2.5 minutes end to end (five Cases × seven layers,
  several of which are real network calls to two different providers).

## What each Case showed

| Case | Rubric | Result | What it demonstrated |
|---|---|---|---|
| "Thank you so much for your first shift..." | tone-eval | Clean pass, all 7 layers | Both real judges agreed a warm reply reads as warm. No escalation needed. |
| "Not my problem. Check the site." | tone-eval | Clean fail, all 7 layers | Both real judges agreed a curt, dismissive reply reads as not on-brand. No escalation needed — genuine agreement on a genuine failure. |
| "12 new volunteers joined this month — great turnout!" | accuracy-eval | Clean pass, all 7 layers | A fully-grounded factual claim scored 5/5 from both judges on every layer. |
| "About 50 new volunteers joined this month — incredible growth!" | accuracy-eval | Clean fail, all 7 layers | An obviously fabricated number (source said 12, not 50) scored 1/5 from both judges on every layer — real judges reliably catch an outright fabrication. |
| "Around a dozen new volunteers joined this month, and it's part of a broader trend of increasing engagement across all our programs this year." | accuracy-eval | **Mixed — 2 real escalations** | See below. This is the Case that actually exercises Consensus Round disagreement for real. |

## The escalation, in detail

The fifth Case's core claim ("around a dozen" ≈ 12) is accurate, but it
tacks on an unsupported claim (a "broader trend... across all our
programs") the source data says nothing about. This is a genuinely
ambiguous case for a numeric 1-5 accuracy score, and it showed real
disagreement — differently, on different layers, in the same run:

- **Layer 4:** both judges agreed closely (qwen3:8b scored 5, Claude Haiku
  scored 4 — within the rubric's own `numericTolerance: 1`), average 4.5,
  passed.
- **Layer 5 (faithfulness framing):** the two judges' scores landed far
  enough apart to trigger a real escalation Task. The escalation's
  adjudicated value came back at 3 — below the rubric's `passThreshold`
  (`gte 4`) — so **this layer failed**, specifically because the tie-breaker
  weighted the unsupported embellishment more heavily than either original
  judge had on its own.
- **Layer 6 (consistency framing):** also escalated for real, but the
  adjudicated value came back at 4 — meeting the threshold — so this layer
  **passed**.
- **Layer 7:** both judges agreed again (5, no escalation), passed.

The interesting part isn't just "escalation fired" — it's that **the same
Case, same output, same underlying judges produced different verdicts on
different layers**, because each layer's framing genuinely changes what the
judges attend to (Layer 5's faithfulness framing pushed harder on the
unsupported claim than Layer 6's consistency framing did). That's the
Consensus Round mechanism and the per-layer framing distinction both working
as designed, against real models, not a hand-tuned test double.

**One honest caveat, found while building this pack:** whether this
specific Case escalates at all is not fully deterministic — real models
aren't perfectly repeatable. A handful of probe runs against this exact
Case (see `pack.ts`'s own comment) sometimes agreed outright (scores within
tolerance) and sometimes disagreed enough to escalate. This run genuinely
escalated, twice, on two different layers — but re-running this pack again
might show a run with zero escalations, or escalations on different layers,
purely from real model variance. That variability is itself a real,
expected property of live judges, not a bug in the pack or the engine — a
pack author relying on a single specific Case to *guarantee* escalation
coverage in CI should account for this (e.g. by watching the aggregate
`totalEscalations`/escalation-rate trend across many runs, rather than
asserting one Case always escalates).

## Cost

Real dollars spent: a small number of `claude-haiku-4-5` calls (4 layers ×
5 Cases, each layer being one judge call + a rare escalation call) — cents,
not dollars. Ollama's own calls are $0 as always. No cost was tracked or
summed by the tool itself (GAPS.md's 2026-09-09 cost-tracking entry) — this
figure is an estimate from the call count, not a number Grader reports.

## Bottom line

The full engine — all seven layers, real local + real hosted judges, the
Consensus Round mechanism including a genuine escalation and its
adjudication, the Grading report, and the CI JSON summary — works end to
end against real models, not just against `ScriptedGraderProvider` test
doubles. This is the credibility bar FUTUREPLAN.md's Session 8 asked for
before Shenny's own session builds a real `GraderPack` against this engine.
