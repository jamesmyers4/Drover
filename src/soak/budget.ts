/**
 * Soak mode's own budget guard (CTS.md Soak Session 3; CONTEXT.md Glossary:
 * "SoakBudget"). Unlike Grader's `graderCeilingUsd` (which bounds only the
 * rare escalation path), this bounds the *entire* run — Soak mode is the
 * first mode that can otherwise run real Sonnet-calling backbone traffic
 * unattended for hours with no cost ceiling at all.
 *
 * Checked between turns, never mid-turn — the same "checked between, not
 * mid-, unit of work" contract `SessionBudget`/`GraderBudget` already
 * established: a turn already in flight when spend crosses the ceiling is
 * still allowed to finish (there's no way to know a turn's real cost before
 * its response returns), but the next turn's dispatch is refused.
 */

export class SoakBudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly ceilingUsd: number,
  ) {
    super(
      `Soak run spend ($${spentUsd.toFixed(4)}) has already reached or exceeded the configured ` +
        `budget ceiling ($${ceilingUsd.toFixed(4)}) — no further turns may dispatch for this run.`,
    );
    this.name = "SoakBudgetExceededError";
  }
}

/** A running total of real (or estimated) turn spend, checked before every turn dispatch across both scheduler lanes. */
export class SoakBudget {
  private spentUsd = 0;

  constructor(readonly ceilingUsd: number) {}

  get spent(): number {
    return this.spentUsd;
  }

  /** Records real or estimated cost from a completed turn (see `SOAK_COST_HEADER` in scheduler.ts). */
  record(costUsd: number): void {
    this.spentUsd += costUsd;
  }

  /**
   * Throws if the running total has already reached the ceiling. Called
   * immediately before each turn dispatch, in both scheduler lanes — a
   * graceful stop (drain in-flight work, write the final `soak_runs` row,
   * never die mid-write) follows from the caller catching this between
   * turns, not from anything this class does itself.
   */
  assertCanDispatch(): void {
    if (this.spentUsd >= this.ceilingUsd) {
      throw new SoakBudgetExceededError(this.spentUsd, this.ceilingUsd);
    }
  }
}
