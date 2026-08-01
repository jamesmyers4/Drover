/**
 * Grader's own budget guard (FUTUREPLAN.md Grader Session 5). Unlike the
 * simulation stack's dollar ceilings, routine Grader operation is $0 by
 * design (local judges) — `graderCeilingUsd` exists purely to bound the rare
 * hosted-escalation path, not a per-Grading-Run cost the way
 * `BudgetConfig.runCeilingUsd` bounds the actor tier.
 *
 * Enforced with a per-dispatch running-total check *before* each escalation
 * Task, not a single pre-flight estimate — a Consensus Round's escalation
 * fan-out is dynamic and only discovered at runtime (0 to N scoped Tasks,
 * N = Check count), so a startup-only check could never see it coming. This
 * mirrors `dataPolicy`'s own per-dispatch enforcement precedent (ADR 0002):
 * both guards exist specifically because escalation happens mid-run, not at
 * a single knowable checkpoint.
 */

export class GraderBudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly ceilingUsd: number,
  ) {
    super(
      `Grader escalation spend ($${spentUsd.toFixed(4)}) has already reached or exceeded the ` +
        `configured graderCeilingUsd ($${ceilingUsd.toFixed(4)}) — no further escalation Tasks ` +
        "may dispatch for this Grading Run.",
    );
    this.name = "GraderBudgetExceededError";
  }
}

/**
 * A running total of real escalation spend, checked before every escalation
 * Task dispatch. Unset `ceilingUsd` means uncapped (the old, pre-Session-5
 * behavior) — matches the actor tier's own optional-ceiling precedent
 * (`BudgetConfig.analystCeilingUsd`).
 */
export class GraderBudget {
  private spentUsd = 0;

  constructor(readonly ceilingUsd?: number) {}

  get spent(): number {
    return this.spentUsd;
  }

  /** Records real billed cost from a completed escalation call. */
  record(costUsd: number): void {
    this.spentUsd += costUsd;
  }

  /**
   * Throws if the running total has already reached the ceiling. Called
   * immediately before each escalation Task dispatch — a call that pushes
   * spend *past* the ceiling is still allowed to complete once started
   * (there's no way to know a call's real cost before it returns), but the
   * next escalation attempt after that is refused. Same reasoning as the
   * actor tier's `SessionBudget.exceeded` check happening between calls, not
   * mid-call.
   */
  assertCanDispatch(): void {
    if (this.ceilingUsd !== undefined && this.spentUsd >= this.ceilingUsd) {
      throw new GraderBudgetExceededError(this.spentUsd, this.ceilingUsd);
    }
  }
}
