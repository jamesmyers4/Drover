# Grader consensus is exempt from the "no quorum" non-goal

**Status:** accepted

`CONTEXT.md`'s v1 non-goals bar "multi-model quorum/approval voting," written specifically to keep the Fixer tier's autonomous-code-change approval out of v1. The new **Grader** subsystem (see `FUTUREPLAN.md`) uses the same N-of-M-models-must-agree shape, but to grade a target app's AI-generated text output, not to approve a code change or act on any system. It never writes code, opens a PR, or touches the target app.

Decided to treat this as a scoped exception rather than a repeal: the non-goal is narrowed to quorum for **autonomous actions** (Fixer-tier approvals). Grader consensus is a distinct mechanism — it produces a pass/fail/score judgment, always reviewed by a human before acting on it, same as any other Drover finding.

Grader is also a **separate subsystem, not a fourth tier** (see `CONTEXT.md`'s Glossary): the existing Actor/Analyst/Fixer tiers are roles within one pipeline operating on the same `runs`/`sessions`/`action_events` lineage. Grader's input is arbitrary external content handed in through an adapter — it doesn't participate in that lineage, runs fully standalone via its own CLI entry point, and is treated as new territory allowed to deviate from `CONTEXT.md`'s existing v1 boundaries where it makes sense.
