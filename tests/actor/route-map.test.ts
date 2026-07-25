import type { Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { buildRouteMapContext } from "../../src/actor/route-map.js";
import type { TreelineAdapter } from "../../src/treeline/adapter.js";

// buildRouteMapContext never touches the browser it's handed (only the
// adapter's resolveSeedUrl does, and that's faked below), so an empty stand-in
// is enough — no real browser launch needed for this unit-level suite.
const fakeBrowser = {} as Browser;
const baseUrl = "http://localhost:3000";

function makeAdapter(resolveSeedUrl: TreelineAdapter["resolveSeedUrl"]): TreelineAdapter {
  return {
    kind: "stub",
    performLogin: vi.fn(),
    checkAuthStillValid: vi.fn(),
    detectAuthWall: vi.fn(),
    resolveSeedUrl,
  };
}

describe("buildRouteMapContext", () => {
  it('returns undefined for familiarity "new" without ever calling the adapter', async () => {
    const resolveSeedUrl = vi.fn();
    const adapter = makeAdapter(resolveSeedUrl);

    const result = await buildRouteMapContext(adapter, fakeBrowser, baseUrl, "new");

    expect(result).toBeUndefined();
    expect(resolveSeedUrl).not.toHaveBeenCalled();
  });

  it("extracts, dedupes, and formats routes from the seed page's HTML for a returning persona", async () => {
    const html = `
      <a href="/dashboard">Dashboard</a>
      <a href="/horses?sort=name">Horses</a>
      <a href="https://other.example.com/external">External</a>
      <a href="/dashboard">Dashboard again</a>
      <a href="#section">Jump to section</a>
      <a href="http://[invalid">Malformed, must not throw</a>
    `;
    const adapter = makeAdapter(async () => ({ resolvedUrl: baseUrl, html }));

    const result = await buildRouteMapContext(adapter, fakeBrowser, baseUrl, "returning");

    // "/dashboard" appears once despite two links (Set dedup), "#section" is
    // excluded by the href regex itself (fragment-only), and the malformed
    // "http://[invalid" is skipped via extractRoutes' catch rather than
    // crashing the whole build.
    expect(result).toBe("- /dashboard\n- /horses?sort=name\n- /external");
  });

  it("also builds a route map for a veteran persona", async () => {
    const adapter = makeAdapter(async () => ({
      resolvedUrl: baseUrl,
      html: '<a href="/settings">Settings</a>',
    }));

    const result = await buildRouteMapContext(adapter, fakeBrowser, baseUrl, "veteran");

    expect(result).toBe("- /settings");
  });

  it("caps at MAX_ROUTES (20) distinct links", async () => {
    const html = Array.from({ length: 25 }, (_, i) => `<a href="/route${i}">Route ${i}</a>`).join(
      "\n",
    );
    const adapter = makeAdapter(async () => ({ resolvedUrl: baseUrl, html }));

    const result = await buildRouteMapContext(adapter, fakeBrowser, baseUrl, "returning");

    const lines = result?.split("\n") ?? [];
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("- /route0");
    expect(lines[19]).toBe("- /route19");
  });

  it(
    "does not actually skip mailto:/javascript: links despite the module's own doc comment " +
      '("Not a resolvable URL (mailto:, javascript:, etc.) — skip.") — both parse as absolute ' +
      "URLs with their own scheme rather than throwing, so they end up in the route list with " +
      "an opaque, path-shaped value. Documented here as real behavior, not changed.",
    async () => {
      const html =
        '<a href="mailto:volunteer@example.org">Email</a><a href="javascript:void(0)">Click</a>';
      const adapter = makeAdapter(async () => ({ resolvedUrl: baseUrl, html }));

      const result = await buildRouteMapContext(adapter, fakeBrowser, baseUrl, "returning");

      expect(result).toBe("- volunteer@example.org\n- void(0)");
    },
  );

  it("returns undefined when the seed page resolves with no html", async () => {
    const adapter = makeAdapter(async () => ({ resolvedUrl: baseUrl, html: null }));

    const result = await buildRouteMapContext(adapter, fakeBrowser, baseUrl, "returning");

    expect(result).toBeUndefined();
  });

  it("returns undefined when the html has no extractable links", async () => {
    const adapter = makeAdapter(async () => ({
      resolvedUrl: baseUrl,
      html: "<p>No links here.</p>",
    }));

    const result = await buildRouteMapContext(adapter, fakeBrowser, baseUrl, "returning");

    expect(result).toBeUndefined();
  });

  it("returns undefined, not a thrown error, when resolveSeedUrl rejects", async () => {
    const adapter = makeAdapter(async () => {
      throw new Error("treeLine unavailable");
    });

    const result = await buildRouteMapContext(adapter, fakeBrowser, baseUrl, "returning");

    expect(result).toBeUndefined();
  });
});
