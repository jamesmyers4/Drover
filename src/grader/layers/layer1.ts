/**
 * Layer 1 — deterministic schema/format checks (FUTUREPLAN.md's layer
 * catalogue, §1.1). Plain synchronous code, no model call, no rubric
 * consumption — this is exactly why it's the first real layer built
 * (Grader Session 3): it proves the scheduler's dispatch/DAG/skip logic
 * without needing any model infrastructure to also be working.
 *
 * Checks a Case's `output` for the basic structural properties any
 * generated content should have regardless of what it actually says:
 * present, JSON-serializable, and non-empty. Overall Task status is "pass"
 * only if every Check passes — there's no partial-credit notion at this
 * layer, unlike a scored rubric-based layer.
 */

import type { LayerCheckOutcome, LayerImplementation, LayerRunContext } from "../layer.js";
import type { CheckResult } from "../types.js";

function checkOutputPresent(output: unknown): CheckResult {
  const present = output !== undefined && output !== null;
  return {
    name: "output-present",
    value: present,
    reasoning: present
      ? "Case.output is neither undefined nor null."
      : "Case.output is undefined or null.",
  };
}

function checkOutputSerializable(output: unknown): CheckResult {
  let serializable: boolean;
  try {
    serializable = JSON.stringify(output) !== undefined;
  } catch {
    serializable = false;
  }
  return {
    name: "output-json-serializable",
    value: serializable,
    reasoning: serializable
      ? "Case.output serializes to JSON without error."
      : "Case.output could not be JSON-serialized (circular reference, BigInt, or undefined).",
  };
}

function checkOutputNonEmpty(output: unknown): CheckResult {
  let nonEmpty: boolean;
  if (typeof output === "string") nonEmpty = output.trim().length > 0;
  else if (Array.isArray(output)) nonEmpty = output.length > 0;
  else if (typeof output === "object" && output !== null) nonEmpty = Object.keys(output).length > 0;
  else nonEmpty = output !== undefined && output !== null;
  return {
    name: "output-non-empty",
    value: nonEmpty,
    reasoning: nonEmpty
      ? "Case.output has non-empty content."
      : "Case.output is an empty string, array, or object.",
  };
}

export const layer1: LayerImplementation = {
  layerId: 1,
  run(ctx: LayerRunContext): LayerCheckOutcome {
    const output = ctx.gradingCase.output;
    const checks: CheckResult[] = [
      checkOutputPresent(output),
      checkOutputSerializable(output),
      checkOutputNonEmpty(output),
    ];
    const status = checks.every((check) => check.value === true) ? "pass" : "fail";
    return { status, checks };
  },
};
