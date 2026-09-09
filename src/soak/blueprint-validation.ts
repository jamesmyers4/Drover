/**
 * Static `SoakBlueprint` validation — checked before anything spends real
 * budget or hits a real target (CTS.md Session 2), same "fail before
 * spending" discipline `validateGraderPack`/`scripts/preflight-hhops.ts`
 * already established for the other two subsystems.
 *
 * Blueprint modules load via `loadDefaultExport` (tsx's loader — transpiles
 * but does not type-check), so a blueprint author's `.ts` file satisfying
 * `SoakBlueprint`'s shape at compile time is nothing this module can assume;
 * every field is treated as `unknown` and actually checked.
 */

import type { SoakBlueprint, SoakDataPolicy } from "./types.js";

export type SoakBlueprintValidationIssueCode =
  | "empty-variation-pools"
  | "empty-pool-examples"
  | "invalid-pool-path"
  | "invalid-pipeline-budget"
  | "unmatched-pipeline-lane"
  | "invalid-budget-ceiling"
  | "invalid-max-duration"
  | "invalid-data-policy"
  | "malformed-target-url"
  | "invalid-pacing-range"
  | "invalid-driver-provider"
  | "data-policy-violation";

export interface SoakBlueprintValidationIssue {
  code: SoakBlueprintValidationIssueCode;
  message: string;
}

/** Carries every issue found in one pass — same rationale as `GraderPackValidationError`: a blueprint author fixing one problem at a time against a single-issue error would mean re-running validation once per fix. */
export class SoakBlueprintValidationError extends Error {
  readonly issues: SoakBlueprintValidationIssue[];

  constructor(issues: SoakBlueprintValidationIssue[]) {
    super(
      `SoakBlueprint failed static validation (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n` +
        issues.map((issue) => `  - [${issue.code}] ${issue.message}`).join("\n"),
    );
    this.name = "SoakBlueprintValidationError";
    this.issues = issues;
  }
}

const VALID_DATA_POLICIES: ReadonlySet<string> = new Set(["synthetic-only", "restricted"]);

/**
 * Approved soak driver providers — today this is just Ollama (ADR 0006/0009:
 * Soak's driver is Ollama-only by construction), but the check is written as
 * an approved-provider set (mirroring `assertDataPolicyAllowed`'s own shape
 * in `src/actor/provider.ts`) rather than a hardcoded equality check, so a
 * second driver provider is a config change here, not a rewrite — CTS.md's
 * own "explicitly still open" note flags this exact question as unresolved
 * long-term; this is a pragmatic, easily-extended answer for now.
 */
const APPROVED_SOAK_DRIVER_PROVIDERS: ReadonlySet<string> = new Set(["ollama"]);

export class SoakDataPolicyViolationError extends Error {
  constructor(dataPolicy: SoakDataPolicy, driverProvider: string) {
    super(
      `dataPolicy "${dataPolicy}" does not permit soak driver provider "${driverProvider}". ` +
        "A restricted blueprint's driver must be Ollama — unlike the actor tier's " +
        '"restricted"-but-Anthropic\'s-fine bundling, Soak mode has no hosted-provider ' +
        'exception (see CTS.md\'s "Notes for whoever picks up the Shenny-side session").',
    );
    this.name = "SoakDataPolicyViolationError";
  }
}

/**
 * Enforced, not advisory — checked here at blueprint-validation time
 * (before anything spends real budget), and re-checked at actual dispatch
 * time in Session 4 (defense-in-depth, same precedent ADR 0002 established
 * for Grader's `assertHostedGraderDispatchAllowed`: one chokepoint isn't
 * trusted alone).
 */
export function assertSoakDataPolicyAllowed(
  dataPolicy: SoakDataPolicy,
  driverProvider: string,
): void {
  if (dataPolicy === "restricted" && !APPROVED_SOAK_DRIVER_PROVIDERS.has(driverProvider)) {
    throw new SoakDataPolicyViolationError(dataPolicy, driverProvider);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWellFormedUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates `variationPools` and returns the set of lanes actually declared
 * (used by `validateUnmatchedPipelineLanes` below) — `undefined` when the
 * array itself is malformed, so the caller can skip the cross-check rather
 * than reporting a confusing second error derived from bad data.
 */
function validateVariationPools(
  rawPools: unknown,
  issues: SoakBlueprintValidationIssue[],
): Set<string> | undefined {
  if (!Array.isArray(rawPools) || rawPools.length === 0) {
    issues.push({
      code: "empty-variation-pools",
      message:
        '"variationPools" must be a non-empty array — a soak run has nothing to draw turn ' +
        "content from otherwise.",
    });
    return undefined;
  }

  const lanes = new Set<string>();
  rawPools.forEach((rawPool: unknown, i: number) => {
    if (!isPlainObject(rawPool)) {
      issues.push({
        code: "empty-pool-examples",
        message: `variationPools[${i}] must be an object.`,
      });
      return;
    }
    const label =
      typeof rawPool.name === "string" && rawPool.name.length > 0 ? `"${rawPool.name}"` : `[${i}]`;
    if (typeof rawPool.lane === "string" && rawPool.lane.length > 0) lanes.add(rawPool.lane);

    const examples = rawPool.examples;
    if (!Array.isArray(examples) || examples.length === 0) {
      issues.push({
        code: "empty-pool-examples",
        message: `variationPools ${label} must have at least one Claude-authored example narrative in "examples".`,
      });
    }

    if (typeof rawPool.path !== "string" || rawPool.path.length === 0) {
      issues.push({
        code: "invalid-pool-path",
        message: `variationPools ${label}.path must be a non-empty string — the scheduler has nowhere to dispatch this pool's turns otherwise.`,
      });
    }
  });
  return lanes;
}

function validatePipelineBudgets(
  rawBudgets: unknown,
  issues: SoakBlueprintValidationIssue[],
): void {
  if (!Array.isArray(rawBudgets)) {
    issues.push({
      code: "invalid-pipeline-budget",
      message: '"pipelineBudgets" must be an array (use an empty array if there are none).',
    });
    return;
  }

  rawBudgets.forEach((rawBudget: unknown, i: number) => {
    if (!isPlainObject(rawBudget)) {
      issues.push({
        code: "invalid-pipeline-budget",
        message: `pipelineBudgets[${i}] must be an object.`,
      });
      return;
    }
    const label =
      typeof rawBudget.pipeline === "string" && rawBudget.pipeline.length > 0
        ? `"${rawBudget.pipeline}"`
        : `[${i}]`;
    const maxCalls = rawBudget.maxCallsPerRun;
    if (!Number.isInteger(maxCalls) || (maxCalls as number) < 0) {
      issues.push({
        code: "invalid-pipeline-budget",
        message: `pipelineBudgets ${label}.maxCallsPerRun must be a non-negative integer, got ${JSON.stringify(maxCalls)}.`,
      });
    }
  });
}

/**
 * Cross-checks every `pipelineBudgets[*].pipeline` against the lanes
 * `variationPools` actually declares — a mismatch is a silent, confusing
 * dead lane at runtime (the scheduler just never dispatches for it) rather
 * than a loud failure, so it's caught here instead. Only runs when both
 * halves parsed as well-formed arrays (skipped otherwise, since either
 * malformed-shape error already reported is a clearer signal on its own).
 */
function validateUnmatchedPipelineLanes(
  rawBudgets: unknown,
  lanes: Set<string> | undefined,
  issues: SoakBlueprintValidationIssue[],
): void {
  if (!Array.isArray(rawBudgets) || lanes === undefined) return;
  for (const rawBudget of rawBudgets) {
    if (!isPlainObject(rawBudget) || typeof rawBudget.pipeline !== "string") continue;
    if (!lanes.has(rawBudget.pipeline)) {
      issues.push({
        code: "unmatched-pipeline-lane",
        message: `pipelineBudgets references pipeline "${rawBudget.pipeline}", but no variationPools entry declares that lane — this pipeline's lane would silently dispatch nothing.`,
      });
    }
  }
}

function validatePacingRange(rawValue: unknown, issues: SoakBlueprintValidationIssue[]): void {
  const minMs = isPlainObject(rawValue) ? rawValue.minMs : undefined;
  const maxMs = isPlainObject(rawValue) ? rawValue.maxMs : undefined;
  const validMin = typeof minMs === "number" && Number.isFinite(minMs) && minMs >= 0;
  const validMax = typeof maxMs === "number" && Number.isFinite(maxMs) && maxMs >= 0;
  if (!validMin || !validMax || (minMs as number) > (maxMs as number)) {
    issues.push({
      code: "invalid-pacing-range",
      message: `"pacingMsRange" must be { minMs, maxMs } with both non-negative and minMs <= maxMs, got ${JSON.stringify(rawValue)}.`,
    });
  }
}

function validateBudget(rawBudget: unknown, issues: SoakBlueprintValidationIssue[]): void {
  const ceilingUsd = isPlainObject(rawBudget) ? rawBudget.ceilingUsd : undefined;
  if (typeof ceilingUsd !== "number" || !Number.isFinite(ceilingUsd) || ceilingUsd <= 0) {
    issues.push({
      code: "invalid-budget-ceiling",
      message:
        '"budget.ceilingUsd" must be present and a positive number — without it Soak mode ' +
        "can run real Sonnet-calling backbone traffic unattended for hours with no cost " +
        'ceiling at all (CONTEXT.md Glossary: "SoakBudget").',
    });
  }
}

function validateMaxDurationHours(rawValue: unknown, issues: SoakBlueprintValidationIssue[]): void {
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue <= 0) {
    issues.push({
      code: "invalid-max-duration",
      message: `"maxDurationHours" must be present and a positive number, got ${JSON.stringify(rawValue)}.`,
    });
  }
}

function validateDataPolicy(rawValue: unknown, issues: SoakBlueprintValidationIssue[]): void {
  if (typeof rawValue !== "string" || !VALID_DATA_POLICIES.has(rawValue)) {
    issues.push({
      code: "invalid-data-policy",
      message: `"dataPolicy" must be "synthetic-only" or "restricted", got ${JSON.stringify(rawValue)}.`,
    });
  }
}

function validateTargetBaseUrl(rawValue: unknown, issues: SoakBlueprintValidationIssue[]): void {
  if (!isWellFormedUrl(rawValue)) {
    issues.push({
      code: "malformed-target-url",
      message: `"targetBaseUrl" must be a well-formed URL, got ${JSON.stringify(rawValue)}.`,
    });
  }
}

function validateDriverProvider(rawValue: unknown, issues: SoakBlueprintValidationIssue[]): void {
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    issues.push({
      code: "invalid-driver-provider",
      message: `"driverProvider" must be a non-empty string (e.g. "ollama"), got ${JSON.stringify(rawValue)}.`,
    });
  }
}

/**
 * Validates a `SoakBlueprint` before any real work runs against it — fails
 * loudly, with every issue found in one pass, rather than partway through
 * an unattended overnight run. Throws `SoakBlueprintValidationError`
 * (carrying every issue found, not just the first) if invalid; returns
 * normally otherwise.
 */
export function validateSoakBlueprint(blueprint: SoakBlueprint): void {
  const issues: SoakBlueprintValidationIssue[] = [];

  const lanes = validateVariationPools(blueprint.variationPools, issues);
  validatePipelineBudgets(blueprint.pipelineBudgets, issues);
  validateUnmatchedPipelineLanes(blueprint.pipelineBudgets, lanes, issues);
  validateBudget(blueprint.budget, issues);
  validateMaxDurationHours(blueprint.maxDurationHours, issues);
  validateDataPolicy(blueprint.dataPolicy, issues);
  validateTargetBaseUrl(blueprint.targetBaseUrl, issues);
  validatePacingRange(blueprint.pacingMsRange, issues);
  validateDriverProvider(blueprint.driverProvider, issues);

  const dataPolicyValid =
    typeof blueprint.dataPolicy === "string" && VALID_DATA_POLICIES.has(blueprint.dataPolicy);
  const driverProviderValid =
    typeof blueprint.driverProvider === "string" && blueprint.driverProvider.length > 0;
  if (dataPolicyValid && driverProviderValid) {
    try {
      assertSoakDataPolicyAllowed(blueprint.dataPolicy, blueprint.driverProvider);
    } catch (err) {
      issues.push({
        code: "data-policy-violation",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (issues.length > 0) {
    throw new SoakBlueprintValidationError(issues);
  }
}
