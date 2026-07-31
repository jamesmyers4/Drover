# Grader CI wiring: self-hosted runner only, full runs on a schedule, versioned JSON summary

**Status:** accepted

FUTUREPLAN.md's open-decisions list asked how consuming repos (e.g. Shenny) wire Grader into their own CI. The naive framing — "make `drover grade` CI-friendly, i.e. exit code 0/nonzero" — turned out to gloss over the actual hard part: Question 10's default judge pool is two local machines on home hardware, and a standard cloud-hosted CI runner has no network path to either.

## Decision

1. **Judge-pool reachability.** v1 supports CI wiring *only* via a self-hosted runner on the same network as the local judge-pool boxes. This is a deployment requirement for whoever wires CI (documented for Shenny's side), not something Grader solves in code. A `synthetic-only` GraderPack could alternatively route to a standard cloud runner + Anthropic, but that's a distinct, secondary path — not the default, and not the expected shape for a `restricted` pack like Shenny's.
2. **Latency / run scope.** No separate "fast CI subset" for v1. CI wiring runs the *same* full Grading Run (all Cases, all layers, per-Check consensus, sequential dispatch per ADR 0004) as any other invocation, triggered on a schedule (nightly / on-merge-to-main) rather than gating every PR — matching Part 4/§3's "cheap, unattended, overnight" framing rather than fighting it. A reduced/PR-gating run mode is a real, named, deferred idea (see Open questions below), not silently assumed to already work.
3. **Output contract.** The CLI emits both a real exit code (for gating) and a structured JSON summary preserving per-Check resolution detail (never collapsed to bare pass/fail) — a consuming workflow can render what actually disagreed, not just red/green.

## Consequences and open questions (deliberately deferred, not solved here)

- **New exposure surface.** A self-hosted runner reachable from CI means CI-triggered jobs now have network reach to both local judge-pool boxes. For a `restricted` GraderPack, this is a third exposure dimension alongside Question 9's "which model sees the content" and "where does the result land at rest" — now also "what network segment can reach the boxes holding that content." Flagged as a deployment-side consideration for whoever wires this, same as Question 9's data-at-rest tail — not resolved here.
- **Fail-threshold policy is unspecified, not just unhardcoded.** "GraderPack config, not hardcoded" names *where* the policy lives, not *what* it's made of. Question 11 deliberately kept a Round's outcome from collapsing to opaque pass/fail — a CI gate eventually has to perform some version of that collapse, and there's no self-evident shape for it yet (simple count-of-hard-fails vs. percentage vs. layer-weighted vs. treating a rising escalation *rate* itself as an independent fail signal, per the tracking concern raised under Question 10). Real open question, explicitly deferred.
- **The JSON summary schema is a durable contract, not an implementation detail.** The same "hard to reverse once Shenny builds against it" reasoning that makes this whole decision ADR-worthy applies to the summary's shape specifically. Intent: the schema should be versioned (e.g. a `schemaVersion` field from day one) so a future format change is an explicit, plannable migration for consuming CI, not an unplanned breakage. Exact versioning scheme not decided here.
