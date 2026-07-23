/**
 * Cross-run finding identity key (CONTEXT.md "Data capture & storage": each
 * finding "carries a status tag across runs"; BUILD-STATE.md S1 decision:
 * "finding type + normalized route + target identifier"). Session 3 shipped
 * a provisional version inline in src/actor/findings.ts; this is the real
 * one, owned by Session 4 and shared by both the actor tier (finding
 * creation) and the orchestrator (cross-run reconciliation).
 *
 * Findings anchor to whatever string the caller had on hand — a page URL, or
 * an observation target like `"500 GET http://host/path?x=1"` /
 * `"FAILED GET http://host/path"` from src/browser/session.ts's listeners.
 * `normalizeRoute` strips origin, query, and hash so the same route matches
 * across runs (and across hosts, e.g. a staging URL that changes port
 * locally) while an HTTP method embedded in the target still disambiguates
 * two different requests to the same route.
 */

const EMBEDDED_URL_PATTERN = /https?:\/\/\S+/;
const EMBEDDED_METHOD_PATTERN = /^(?:\d{3}|FAILED)\s+([A-Z]+)\s/;

/** Origin/query/hash-stripped path for a URL-shaped or URL-prefixed target string. */
export function normalizeRoute(target: string): string {
  const urlMatch = EMBEDDED_URL_PATTERN.exec(target);
  const candidate = urlMatch ? urlMatch[0] : target;
  try {
    const url = new URL(candidate);
    return url.pathname || "/";
  } catch {
    // Not URL-shaped at all (e.g. a CSS selector) — use the trimmed target as-is.
    return target.trim();
  }
}

/** Extracts an HTTP method from an observation target like "500 GET ..." or "FAILED GET ...". */
function extractMethod(target: string): string | undefined {
  return EMBEDDED_METHOD_PATTERN.exec(target)?.[1];
}

/**
 * The stable cross-run identity for a finding: type + normalized route,
 * plus an HTTP method suffix when one is present or explicitly supplied —
 * lets two different requests to the same route (e.g. GET vs POST) count
 * as distinct recurring findings instead of colliding.
 */
export function computeMatchKey(type: string, target: string, targetIdentifier?: string): string {
  const route = normalizeRoute(target);
  const method = targetIdentifier ?? extractMethod(target);
  return method ? `${type}:${route}:${method}` : `${type}:${route}`;
}
