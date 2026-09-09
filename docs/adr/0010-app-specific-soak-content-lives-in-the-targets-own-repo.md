# App-specific soak content lives in the target's own repo when it has one

**Status:** accepted

FUTUREPLAN.md already drew this boundary for Grader: "Grader lives entirely in Drover... app-specific rubrics/Cases are each consuming app's own work, in its own repo/sessions." `packs/horse-haven-ops/` looks like a counterexample, but isn't one on inspection — Horse Haven Ops has no repo of its own doing this kind of planning work, so its `DomainPack` lives in Drover by necessity, not as the general rule.

Shenny is not in that position. It has its own `CLAUDE.md`, its own `SESSION_LOG.md`, and runs its own planning sessions the same way Drover does. Building Shenny's `GraderPack` (rubric wording for guardrail leaks, groundedness criteria) or Shenny's real `SoakBlueprint` (its entry-text example bank, real staging routes/auth) inside Drover's repo would mean Drover's repo accumulates another project's domain-specific content indefinitely, and would treat this integration inconsistently with the one FUTUREPLAN.md already decided for the same subsystem (Grader).

**Decided:** Drover's repo builds only the generic, target-agnostic engine — the `SoakBlueprint` type, the execution loop, the turn→`Case` adapter shape, the CLI — proved end-to-end against Drover's own `examples/toy-app` fixture (Soak Session 8, mirroring Grader Session 8's reference-pack role). The real Shenny `SoakBlueprint` and Shenny's `GraderPack` are both built in Shenny's own repo, in its own session(s), consuming Drover's published engine the same way `packs/horse-haven-ops/` consumes Drover's `DomainPack` contract today.

**Consequence:** this blueprint's final session hands off to a Shenny-repo session, mirroring FUTUREPLAN.md's own "Notes for whoever picks up the Shenny-side session" closing section. Any future non-Shenny target without its own repo (a Horse-Haven-Ops-shaped case) would instead get its blueprint built in Drover, same exception this ADR carves out explicitly rather than leaving implicit.
