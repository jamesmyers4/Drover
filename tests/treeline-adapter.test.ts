import { existsSync } from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/browser/session.js";
import { createTreelineAdapter, TreelineUnavailableError } from "../src/treeline/adapter.js";
import { type FixtureSite, startFixtureSite } from "./fixtures/site.js";

const INTEGRATION_TIMEOUT = 30_000;

const siblingAcquireDist = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "treeLine",
  "packages",
  "acquire",
  "dist",
  "index.js",
);
const treelineBuilt = existsSync(siblingAcquireDist);

describe("createTreelineAdapter", () => {
  it("falls back to the stub when treeLine is not found", async () => {
    const adapter = await createTreelineAdapter("Z:/definitely/not/here");
    expect(adapter.kind).toBe("stub");
    await expect(
      adapter.performLogin(undefined as never, undefined as never),
    ).rejects.toBeInstanceOf(TreelineUnavailableError);
    await expect(adapter.resolveSeedUrl(undefined as never, "http://x")).rejects.toBeInstanceOf(
      TreelineUnavailableError,
    );
  });

  it.runIf(treelineBuilt)("loads the real adapter from the sibling checkout", async () => {
    const adapter = await createTreelineAdapter();
    expect(adapter.kind).toBe("treeline");
  });
});

describe("adapter against a live browser", () => {
  let browser: Browser;
  let site: FixtureSite;

  beforeAll(async () => {
    browser = await launchBrowser();
    site = await startFixtureSite();
  }, INTEGRATION_TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  it(
    "detectAuthWall: true on a login page, false on a public page (stub and real agree)",
    async () => {
      const adapter = await createTreelineAdapter();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(`${site.baseUrl}/login`);
        expect(await adapter.detectAuthWall(page)).toBe(true);
        await page.goto(`${site.baseUrl}/horses`);
        expect(await adapter.detectAuthWall(page)).toBe(false);
      } finally {
        await context.close();
      }
    },
    INTEGRATION_TIMEOUT,
  );

  it.runIf(treelineBuilt)(
    "real performLogin returns a storageState after a fixture login",
    async () => {
      const adapter = await createTreelineAdapter();
      const state = await adapter.performLogin(browser, {
        loginUrl: `${site.baseUrl}/login`,
        username: "vol",
        password: "pw",
        successIndicator: "#dashboard-heading",
        usernameSelector: "#login-user",
        passwordSelector: "#login-pass",
      });
      expect(Array.isArray(state.cookies)).toBe(true);
      expect(Array.isArray(state.origins)).toBe(true);
    },
    INTEGRATION_TIMEOUT,
  );

  it.runIf(treelineBuilt)(
    "real resolveSeedUrl resolves the fixture home page",
    async () => {
      const adapter = await createTreelineAdapter();
      const { resolvedUrl, html } = await adapter.resolveSeedUrl(browser, `${site.baseUrl}/`);
      expect(resolvedUrl).toBe(`${site.baseUrl}/`);
      expect(html).toContain("Fixture Home");
    },
    INTEGRATION_TIMEOUT,
  );

  it.runIf(treelineBuilt)(
    "real checkAuthStillValid distinguishes dashboard from login page",
    async () => {
      const adapter = await createTreelineAdapter();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(`${site.baseUrl}/dashboard`);
        expect(
          await adapter.checkAuthStillValid(page, "#dashboard-heading", `${site.baseUrl}/login`),
        ).toBe(true);
        await page.goto(`${site.baseUrl}/login`);
        expect(
          await adapter.checkAuthStillValid(page, "#dashboard-heading", `${site.baseUrl}/login`),
        ).toBe(false);
      } finally {
        await context.close();
      }
    },
    INTEGRATION_TIMEOUT,
  );
});
