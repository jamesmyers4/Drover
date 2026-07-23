/**
 * Familiarity-gated treeLine route map context (CONTEXT.md "Relationship to
 * treeLine"): personas with familiarity `returning` or `veteran` get seeded
 * with a lightweight map of known routes, as if they'd used the app before;
 * `new` personas explore cold and get nothing here.
 *
 * The adapter's exposed surface (Session 2) is `resolveSeedUrl`, not a full
 * crawl/route map — so "route map" is approximated as the set of links
 * discoverable from the seed page's HTML. A stub adapter or a resolution
 * failure must not crash the actor loop: it just means no map this session.
 */

import type { Browser } from "playwright";
import type { TreelineAdapter } from "../treeline/adapter.js";
import type { PersonaArchetype } from "../types/index.js";

const MAX_ROUTES = 20;
const HREF_PATTERN = /href\s*=\s*["']([^"'#][^"']*)["']/gi;

function extractRoutes(html: string, baseUrl: string): string[] {
  const routes = new Set<string>();
  for (const match of html.matchAll(HREF_PATTERN)) {
    const href = match[1];
    if (!href) continue;
    try {
      const resolved = new URL(href, baseUrl);
      routes.add(resolved.pathname + resolved.search);
    } catch {
      // Not a resolvable URL (mailto:, javascript:, etc.) — skip.
    }
    if (routes.size >= MAX_ROUTES) break;
  }
  return [...routes];
}

/**
 * Builds a "known routes" context block for returning/veteran personas, or
 * `undefined` for new personas (no map) or when resolution isn't possible.
 */
export async function buildRouteMapContext(
  adapter: TreelineAdapter,
  browser: Browser,
  targetBaseUrl: string,
  familiarity: PersonaArchetype["traits"]["familiarity"],
): Promise<string | undefined> {
  if (familiarity === "new") return undefined;
  try {
    const { html } = await adapter.resolveSeedUrl(browser, targetBaseUrl);
    if (!html) return undefined;
    const routes = extractRoutes(html, targetBaseUrl);
    if (routes.length === 0) return undefined;
    return routes.map((r) => `- ${r}`).join("\n");
  } catch {
    // treeLine unavailable or resolution failed — this persona explores as if new.
    return undefined;
  }
}
