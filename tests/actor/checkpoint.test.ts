import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  evaluateCheckpointDetector,
  evaluateCheckpoints,
  parseCheckpointDetector,
} from "../../src/actor/checkpoint.js";
import { launchBrowser } from "../../src/browser/session.js";
import { type FixtureSite, startFixtureSite } from "../fixtures/site.js";

describe("parseCheckpointDetector", () => {
  it("parses url/selector/text kinds", () => {
    expect(parseCheckpointDetector("url:/dashboard")).toEqual({ kind: "url", value: "/dashboard" });
    expect(parseCheckpointDetector("selector:#dashboard-heading")).toEqual({
      kind: "selector",
      value: "#dashboard-heading",
    });
    expect(parseCheckpointDetector("text:volunteer dashboard")).toEqual({
      kind: "text",
      value: "volunteer dashboard",
    });
  });

  it("rejects a missing kind prefix", () => {
    expect(() => parseCheckpointDetector("no-colon-here")).toThrow(/missing "kind:" prefix/);
  });

  it("rejects an unknown kind", () => {
    expect(() => parseCheckpointDetector("xpath://div")).toThrow(
      /Unknown checkpoint detector kind/,
    );
  });

  it("rejects an empty value", () => {
    expect(() => parseCheckpointDetector("url:")).toThrow(/empty matcher value/);
  });
});

describe("evaluateCheckpointDetector against a live page", () => {
  let browser: Browser;
  let site: FixtureSite;

  beforeAll(async () => {
    browser = await launchBrowser();
    site = await startFixtureSite();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  it("url: matches a substring of the current URL", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${site.baseUrl}/dashboard`);
      expect(await evaluateCheckpointDetector("url:/dashboard", page)).toBe(true);
      expect(await evaluateCheckpointDetector("url:/nonexistent", page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("selector: matches an existing element", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${site.baseUrl}/dashboard`);
      expect(await evaluateCheckpointDetector("selector:#dashboard-heading", page)).toBe(true);
      expect(await evaluateCheckpointDetector("selector:#does-not-exist", page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("text: matches visible body text case-insensitively", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${site.baseUrl}/dashboard`);
      expect(await evaluateCheckpointDetector("text:VOLUNTEER DASHBOARD", page)).toBe(true);
      expect(await evaluateCheckpointDetector("text:nope not here", page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("evaluateCheckpoints returns only the ids that currently match", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${site.baseUrl}/dashboard`);
      const hits = await evaluateCheckpoints(
        [
          { id: "on-dashboard", description: "reached the dashboard", detector: "url:/dashboard" },
          { id: "on-signup", description: "reached signup", detector: "url:/signup" },
        ],
        page,
      );
      expect(hits).toEqual(["on-dashboard"]);
    } finally {
      await context.close();
    }
  });
});
