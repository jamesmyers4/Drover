/**
 * Static `GraderPack` validation — checked before anything spends real work
 * (Task dispatch, any model call), so a pack error is caught up front rather
 * than partway through an unattended overnight run. Its own explicit
 * function, deliberately distinct in scope from a future runtime-LLM-output
 * validator (Q13's ownership-gap fix): this module is about whether the
 * *pack itself* is well-formed, never about whether a judge model's
 * response is. Same "fail before spending budget" precedent
 * `scripts/preflight-hhops.ts` already set for the simulation stack.
 *
 * Checks: every `Case.rubric` key resolves against `GraderPack.rubrics`;
 * every Rubric's `CheckDefinition`s carry the tolerance rule their
 * `scoringType` requires (the Session 1 discriminated union is a
 * compile-time guarantee only — see `validateRubrics`); `layers` is a
 * well-formed sparse map; any declared prerequisite DAG resolves without a
 * cycle.
 *
 * Runtime, not just compile-time, because pack modules load via `tsx`'s
 * loader (see `loadDefaultExport`), which transpiles but does not
 * type-check — a pack author's `.ts` file satisfying `GraderPack`'s shape
 * is nothing this module can assume; it has to actually check.
 */

import type { CaseInput, GraderPack, LayerId, LayerPrerequisite } from "./types.js";

export type GraderPackValidationIssueCode =
  | "unknown-rubric"
  | "malformed-rubric"
  | "malformed-layers"
  | "cyclic-prerequisite"
  | "cases-load-failed";

export interface GraderPackValidationIssue {
  code: GraderPackValidationIssueCode;
  message: string;
}

/** Carries every issue found in one pass — a pack author fixing one problem at a time against a single-issue error would mean re-running validation once per fix. */
export class GraderPackValidationError extends Error {
  readonly issues: GraderPackValidationIssue[];

  constructor(issues: GraderPackValidationIssue[]) {
    super(
      `GraderPack failed static validation (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n` +
        issues.map((issue) => `  - [${issue.code}] ${issue.message}`).join("\n"),
    );
    this.name = "GraderPackValidationError";
    this.issues = issues;
  }
}

const VALID_LAYER_IDS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7]);

function isLayerId(value: unknown): value is LayerId {
  return typeof value === "number" && VALID_LAYER_IDS.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates `layers` is a well-formed sparse map. Treats `pack.layers` as
 * `unknown` rather than trusting its declared `LayerConfig` type — see this
 * module's header comment on why a pack's compile-time type can't be
 * trusted at runtime.
 */
function validateLayers(rawLayers: unknown, issues: GraderPackValidationIssue[]): void {
  if (rawLayers === undefined) return;
  if (!isPlainObject(rawLayers)) {
    issues.push({
      code: "malformed-layers",
      message: `"layers" must be an object keyed by layer id (1-7), got ${Array.isArray(rawLayers) ? "an array" : typeof rawLayers}.`,
    });
    return;
  }

  for (const [rawKey, rawOverride] of Object.entries(rawLayers)) {
    const key = Number(rawKey);
    if (!isLayerId(key)) {
      issues.push({
        code: "malformed-layers",
        message: `"layers" has an invalid key "${rawKey}" — layer ids must be an integer 1-7.`,
      });
      continue;
    }
    if (rawOverride === undefined) continue;
    if (!isPlainObject(rawOverride)) {
      issues.push({
        code: "malformed-layers",
        message: `layers[${key}] must be an object, got ${Array.isArray(rawOverride) ? "an array" : typeof rawOverride}.`,
      });
      continue;
    }

    if (
      "enabled" in rawOverride &&
      rawOverride.enabled !== undefined &&
      typeof rawOverride.enabled !== "boolean"
    ) {
      issues.push({
        code: "malformed-layers",
        message: `layers[${key}].enabled must be a boolean when present.`,
      });
    }

    if (!("requires" in rawOverride) || rawOverride.requires === undefined) continue;
    const requires = rawOverride.requires;
    if (!Array.isArray(requires)) {
      issues.push({
        code: "malformed-layers",
        message: `layers[${key}].requires must be an array when present.`,
      });
      continue;
    }
    requires.forEach((rawPrereq: unknown, i: number) => {
      if (!isPlainObject(rawPrereq)) {
        issues.push({
          code: "malformed-layers",
          message: `layers[${key}].requires[${i}] must be an object with "layerId" and "justification".`,
        });
        return;
      }
      if (!isLayerId(rawPrereq.layerId)) {
        issues.push({
          code: "malformed-layers",
          message: `layers[${key}].requires[${i}].layerId must be an integer 1-7.`,
        });
      }
      const justification = rawPrereq.justification;
      if (typeof justification !== "string" || justification.trim().length === 0) {
        issues.push({
          code: "malformed-layers",
          message:
            `layers[${key}].requires[${i}] is missing a non-empty "justification" string — a ` +
            'declared prerequisite must state why the layer is "structurally meaningless ' +
            "without X\" (Q5's guardrail against cost-flavored intuition eroding the " +
            "always-run-everything default).",
        });
      }
    });
  }
}

/**
 * Builds the declared prerequisite DAG from `layers[*].requires` and checks
 * it resolves without a cycle. Only called once `validateLayers` has found
 * no malformed shape — a malformed `layers` map already reported would
 * otherwise also surface a confusing, redundant cycle-detection message.
 */
function detectPrerequisiteCycle(
  layers: Partial<Record<LayerId, { requires?: LayerPrerequisite[] }>> | undefined,
  issues: GraderPackValidationIssue[],
): void {
  if (!layers) return;

  const edges = new Map<LayerId, LayerId[]>();
  for (const [rawKey, override] of Object.entries(layers)) {
    const key = Number(rawKey) as LayerId;
    const deps = (override?.requires ?? []).map((r) => r.layerId);
    if (deps.length > 0) edges.set(key, deps);
  }

  const UNVISITED = 0;
  const IN_PROGRESS = 1;
  const DONE = 2;
  const state = new Map<LayerId, number>();
  const stack: LayerId[] = [];

  function visit(node: LayerId): LayerId[] | null {
    state.set(node, IN_PROGRESS);
    stack.push(node);
    for (const dep of edges.get(node) ?? []) {
      const depState = state.get(dep) ?? UNVISITED;
      if (depState === IN_PROGRESS) {
        const cycleStart = stack.indexOf(dep);
        return [...stack.slice(cycleStart), dep];
      }
      if (depState === UNVISITED) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, DONE);
    return null;
  }

  for (const node of edges.keys()) {
    if ((state.get(node) ?? UNVISITED) === UNVISITED) {
      const cycle = visit(node);
      if (cycle) {
        issues.push({
          code: "cyclic-prerequisite",
          message: `Declared layer prerequisites form a cycle: ${cycle.join(" -> ")}.`,
        });
        return;
      }
    }
  }
}

/**
 * Validates every Rubric's `CheckDefinition`s carry the tolerance rule
 * their `scoringType` requires. `CheckDefinition` is a discriminated union
 * at compile time (a numeric Check must carry `numericTolerance`, a
 * boolean Check must not) — but a pack loaded via `tsx` isn't type-checked
 * (see this module's header comment), so a rubric can still slip past
 * authoring time with a numeric Check missing its tolerance or a boolean
 * Check carrying a stray one. Left unchecked, that surfaces as a runtime
 * break the first time `consensus.ts` tries to read a tolerance rule that
 * isn't there, partway through a real Grading Run — exactly the failure
 * mode static pack validation exists to catch before any dispatch starts.
 */
function validateRubrics(pack: GraderPack, issues: GraderPackValidationIssue[]): void {
  if (!isPlainObject(pack.rubrics)) {
    issues.push({
      code: "malformed-rubric",
      message: `"rubrics" must be an object keyed by rubric name, got ${typeof pack.rubrics}.`,
    });
    return;
  }

  for (const [rubricKey, rawRubric] of Object.entries(pack.rubrics)) {
    if (!isPlainObject(rawRubric)) {
      issues.push({
        code: "malformed-rubric",
        message: `rubrics["${rubricKey}"] must be an object.`,
      });
      continue;
    }
    const checks = rawRubric.checks;
    if (!Array.isArray(checks)) {
      issues.push({
        code: "malformed-rubric",
        message: `rubrics["${rubricKey}"].checks must be an array.`,
      });
      continue;
    }

    checks.forEach((rawCheck: unknown, i: number) => {
      if (!isPlainObject(rawCheck)) {
        issues.push({
          code: "malformed-rubric",
          message: `rubrics["${rubricKey}"].checks[${i}] must be an object.`,
        });
        return;
      }
      const label =
        typeof rawCheck.name === "string" && rawCheck.name.length > 0
          ? `"${rawCheck.name}"`
          : `[${i}]`;

      if (rawCheck.scoringType === "boolean") {
        if ("numericTolerance" in rawCheck && rawCheck.numericTolerance !== undefined) {
          issues.push({
            code: "malformed-rubric",
            message:
              `rubrics["${rubricKey}"].checks ${label} has scoringType "boolean" but also sets ` +
              "numericTolerance — a boolean Check's agreement rule is exact-match and must not " +
              "declare a tolerance.",
          });
        }
      } else if (rawCheck.scoringType === "numeric") {
        if (
          typeof rawCheck.numericTolerance !== "number" ||
          !Number.isFinite(rawCheck.numericTolerance)
        ) {
          issues.push({
            code: "malformed-rubric",
            message:
              `rubrics["${rubricKey}"].checks ${label} has scoringType "numeric" but is missing ` +
              "a finite numericTolerance — every numeric Check must carry its own tolerance rule " +
              "(Q11: tolerance is never an implicit Round-wide default).",
          });
        }
      } else {
        issues.push({
          code: "malformed-rubric",
          message: `rubrics["${rubricKey}"].checks ${label} has an invalid scoringType "${String(rawCheck.scoringType)}" — must be "boolean" or "numeric".`,
        });
      }
    });
  }
}

/** Loads the pack's Cases and checks every `Case.rubric` key resolves against `GraderPack.rubrics`. */
async function validateCaseRubrics(
  pack: GraderPack,
  issues: GraderPackValidationIssue[],
): Promise<void> {
  let cases: CaseInput[];
  try {
    cases = await pack.loadCases();
  } catch (err) {
    issues.push({
      code: "cases-load-failed",
      message: `pack.loadCases() threw: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const knownRubricKeys = new Set(Object.keys(pack.rubrics ?? {}));
  const unknownRubricKeys = new Set<string>();
  for (const c of cases) {
    if (!knownRubricKeys.has(c.rubric)) unknownRubricKeys.add(c.rubric);
  }
  for (const key of unknownRubricKeys) {
    issues.push({
      code: "unknown-rubric",
      message:
        `A Case references rubric "${key}", which isn't declared in GraderPack.rubrics ` +
        `(known keys: ${[...knownRubricKeys].join(", ") || "none"}).`,
    });
  }
}

/**
 * Validates a `GraderPack` before any real work runs against it. Throws
 * `GraderPackValidationError` (carrying every issue found, not just the
 * first) if the pack is invalid; resolves silently otherwise.
 */
export async function validateGraderPack(pack: GraderPack): Promise<void> {
  const issues: GraderPackValidationIssue[] = [];

  validateLayers(pack.layers, issues);
  if (!issues.some((issue) => issue.code === "malformed-layers")) {
    detectPrerequisiteCycle(pack.layers, issues);
  }
  validateRubrics(pack, issues);
  await validateCaseRubrics(pack, issues);

  if (issues.length > 0) {
    throw new GraderPackValidationError(issues);
  }
}
