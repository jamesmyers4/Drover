# Grader dispatch is sequential by default, but box-aware from the start

**Status:** accepted

The two physical GPU boxes (§3, `FUTUREPLAN.md`) have no shared VRAM, so nothing physically prevents dispatching a Consensus Round's two judge Tasks concurrently, one per box. But this is genuinely new, unvalidated scheduling infrastructure. Decided to mirror the existing `concurrencyCap` precedent (`runDiscovery`: sequential is the safe default, bounded concurrency is opt-in once trusted) rather than treat Grader's scheduler as more trustworthy on day one than discovery runs were.

**v1: fully sequential** — one Task in flight system-wide, regardless of which box it targets. "Sequential" means the dispatch queue is one-at-a-time; it does **not** mean a Consensus Round completes in a fixed number of steps — a per-Check escalation Round (see Question 11 / the Consensus Round glossary entry) can still fan out to a variable number of scoped Tasks, each just dispatched one after another rather than in parallel. This is documented behavior, not a bug, the first time someone watches a Round spawn three escalation Tasks instead of one.

Each Task result still records `executionTarget` (which box/endpoint ran it) as a field distinct from `modelFamily` (see ADR 0003) — so the future concurrency toggle is a config change, not a rewrite. That toggle's natural shape, when it's built: **"one Task per distinct `executionTarget`" dispatched simultaneously**, not arbitrary N-way concurrency — the ceiling is 2, fully specified by the current hardware (§3), not an open-ended concurrency problem.
