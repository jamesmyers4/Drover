/**
 * Rubric-by-reference resolution (Q8) — the first point a layer actually
 * consumes a rubric (Layer 1 doesn't, per the Case glossary entry). A
 * `Case.rubric` is only a key; a layer implementation resolves it against
 * `GraderPack.rubrics` at dispatch time via `resolveRubric`, then snapshots
 * the resolved content (or a hash of it) onto the Task's persisted result
 * via `snapshotRubric` — so a Grading Run's results stay interpretable
 * months later even if the pack's rubric definitions have since changed.
 */

import { createHash } from "node:crypto";
import type { GraderPack, Rubric, RubricSnapshot } from "./types.js";

export class UnknownRubricError extends Error {
  constructor(rubricKey: string) {
    super(
      `Case references rubric "${rubricKey}", which isn't declared in GraderPack.rubrics. ` +
        "This should have been caught by validateGraderPack before dispatch — resolving it " +
        "again here defensively rather than trusting that every caller already validated.",
    );
    this.name = "UnknownRubricError";
  }
}

/** Resolves a `Case.rubric` key against `GraderPack.rubrics`. Throws `UnknownRubricError` if the key is unknown — belt-and-suspenders against `validateGraderPack` being skipped or bypassed. */
export function resolveRubric(pack: GraderPack, rubricKey: string): Rubric {
  const rubric = pack.rubrics[rubricKey];
  if (!rubric) throw new UnknownRubricError(rubricKey);
  return rubric;
}

/**
 * Deterministic content hash of a rubric — stable across process restarts
 * and machines (no key-ordering sensitivity: `JSON.stringify` on an object
 * built with a fixed field order below, not the caller's own key order).
 */
export function snapshotRubric(rubric: Rubric): RubricSnapshot {
  const stableChecks = rubric.checks.map((check) =>
    check.scoringType === "numeric"
      ? {
          name: check.name,
          description: check.description,
          scoringType: check.scoringType,
          numericTolerance: check.numericTolerance,
          passThreshold: check.passThreshold,
        }
      : { name: check.name, description: check.description, scoringType: check.scoringType },
  );
  const stableContent = { key: rubric.key, description: rubric.description, checks: stableChecks };
  const contentHash = createHash("sha256").update(JSON.stringify(stableContent)).digest("hex");
  return { key: rubric.key, contentHash, content: rubric };
}
