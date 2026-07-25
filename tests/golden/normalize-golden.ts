/**
 * Strips known-nondeterministic values out of golden-dump output before it's
 * compared against (or used to regenerate) a checked-in golden file
 * (TESTING.md Session 3). The fixture site (tests/fixtures/site.ts) binds
 * `listen(0, ...)`, so its port — and therefore every URL `dump-run.ts`
 * pulls out of the database — changes on every test run. UUIDs (run/session/
 * event ids) would have the same problem if a dump ever includes one
 * directly, so this normalizes those too as a general safety net, even
 * though the current `dump-run.ts` output deliberately omits raw ids.
 *
 * Costs are *not* normalized here — `ScriptedModelProvider`'s
 * `costPerCallUsd` is fixed per scenario, so total cost across a locked
 * scenario must come out exactly the same every run. If it doesn't, that's
 * a real bug to fix, not something to paper over with normalization.
 */

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface NormalizeGoldenOptions {
  /** The fixture site's base URL for this run — its port is different every run. */
  baseUrl: string;
}

function normalizeString(value: string, opts: NormalizeGoldenOptions): string {
  return value.split(opts.baseUrl).join("<BASE_URL>").replace(UUID_PATTERN, "<UUID>");
}

/** Deep-walks a JSON-like value, normalizing every string leaf it finds. */
export function normalizeGolden<T>(value: T, opts: NormalizeGoldenOptions): T {
  if (typeof value === "string") return normalizeString(value, opts) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => normalizeGolden(v, opts)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) result[key] = normalizeGolden(v, opts);
    return result as T;
  }
  return value;
}
