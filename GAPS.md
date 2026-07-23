# GAPS.md — Drover's own blind spots

Drover shortcomings, missing capabilities, and future-improvement ideas, logged as they surface during builds and real runs (per CONTEXT.md's Learning Loop). Entries here are candidates for post-v1 work — log and move on, don't fix out of scope.

## 2026-07-23 (S3) — No local/self-hosted provider for `restricted` domain packs

CONTEXT.md's "Data routing & privacy" names a fully local model (via Ollama) as the zero-exposure actor-tier option for `restricted` domain packs when cost is a concern beyond staying on Anthropic. Session 3 only implements `AnthropicModelProvider`; `assertDataPolicyAllowed`'s approved-provider set for `restricted` packs is just `["anthropic"]` (`src/actor/provider.ts`). Adopters with a real `restricted` app and no Anthropic budget have no provider to route to yet. Post-v1: add an Ollama-backed `ModelProvider` implementation and add `"ollama"` to the approved set once it exists.

## 2026-07-23 (S3) — Cost of a malformed decide_action call isn't recorded against budget

`AnthropicModelProvider.decide()` computes `usage`/`costUsd` only after `parseDecision` succeeds; if the model's tool call is malformed (`MalformedDecisionError`), the API call was still billed by Anthropic but that cost never reaches `SessionBudget` (the promise rejects before returning usage). In practice this is rare (forced `tool_choice` + a small schema), and the amounts are small, but a session that repeatedly gets malformed output could under-report its real spend. Post-v1: have the provider catch the parse failure internally, still compute and report `usage`, and return an error decision rather than throwing past the usage return.

## 2026-07-23 (S3) — Checkpoint detector DSL is intentionally minimal

`src/actor/checkpoint.ts`'s three matchers (`url:`, `selector:`, `text:`) are substring/existence checks only — no regex, no visibility vs. presence distinction, no combining multiple conditions into one checkpoint (AND/OR). Fine for the toy example and Session 3's tests; Session 8's real Horse Haven Ops pack may need one of these and should extend the DSL then rather than working around it with extra checkpoints.

## 2026-07-23 (S3) — Persona trait numeric range isn't specified in CONTEXT.md

CONTEXT.md types `patience`/`techSavviness` as `number` with no documented range. Session 3 assumed 0..1 normalized (`src/actor/prompt.ts` techSavviness bucketing, `src/actor/loop.ts` patience → retry cap and pacing delay). This needs to be codified explicitly in Session 8's domain-pack authoring guide so pack authors don't guess a different scale (e.g. 1-10).
