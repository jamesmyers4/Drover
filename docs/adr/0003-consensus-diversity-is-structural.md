# Consensus Round model-family diversity is a checked invariant, not an inferred property of hardware topology

**Status:** accepted

FUTUREPLAN.md §1.3 requires judges in a consensus check to come from different model families — same-family judges share blind spots. The convenient default (one judge per physical GPU box) achieves this today only because of what's currently installed where. Nothing in the Task schema or Consensus Round resolution logic actually records or checks model family identity, so the diversity property is true by coincidence, not by construction — and it would break silently the day a box gets reconfigured, a third machine is added, or the same model ends up installed on both boxes for an unrelated reason (capacity, testing, one box being down).

Decided: each Task result carries a `modelFamily` field (family-level identity — two quantizations of the same base model count as one family, not two), and Consensus Round dispatch/resolution asserts distinct `modelFamily` values across the round's member Tasks, independent of which physical machine produced them. Two-judges-one-per-box remains the correct default *operational* layout — this doesn't change the deployment topology, it just makes the diversity guarantee survive changes to that topology instead of silently depending on it.
