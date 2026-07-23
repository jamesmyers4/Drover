import type { Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contextOptionsForDevice } from "../src/browser/device.js";
import { captureScreenshot } from "../src/browser/screenshot.js";
import { BrowserSession, launchBrowser } from "../src/browser/session.js";
import { DroverDb, newId } from "../src/db/database.js";
import type { SimConfig } from "../src/types/index.js";
import { type FixtureSite, startFixtureSite } from "./fixtures/site.js";

const INTEGRATION_TIMEOUT = 30_000;

describe("contextOptionsForDevice", () => {
  it("desktop has no touch and a desktop viewport", () => {
    const opts = contextOptionsForDevice("desktop");
    expect(opts.hasTouch).toBe(false);
    expect(opts.isMobile).toBe(false);
    expect(opts.viewport?.width).toBeGreaterThanOrEqual(1024);
  });

  it("mobile emulates touch, mobile UA, and a narrow viewport", () => {
    const opts = contextOptionsForDevice("mobile");
    expect(opts.hasTouch).toBe(true);
    expect(opts.isMobile).toBe(true);
    expect(opts.viewport?.width).toBeLessThan(500);
    expect(opts.userAgent).toContain("Mobile");
  });

  it("tablet is touch-enabled with a mid-size viewport", () => {
    const opts = contextOptionsForDevice("tablet");
    expect(opts.hasTouch).toBe(true);
    const width = opts.viewport?.width ?? 0;
    expect(width).toBeGreaterThan(500);
  });
});

describe("BrowserSession", () => {
  let browser: Browser;
  let site: FixtureSite;
  let db: DroverDb;
  let sessionId: string;

  const config: SimConfig = {
    targetBaseUrl: "http://localhost",
    runDimensions: { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
    budget: { runCeilingUsd: 1, perSessionSoftCapUsd: 1 },
    modelRouting: {
      actor: { provider: "none", model: "test" },
      analyst: { provider: "none", model: "test" },
    },
  };

  beforeAll(async () => {
    browser = await launchBrowser();
    site = await startFixtureSite();
  }, INTEGRATION_TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  beforeEach(() => {
    db = new DroverDb(":memory:");
    const runId = newId();
    sessionId = newId();
    db.insertRun({ id: runId, appName: "test", config, status: "running", startedAt: Date.now() });
    db.insertSession({
      id: sessionId,
      runId,
      personaId: "p1",
      goalId: "g1",
      status: "running",
      startedAt: Date.now(),
    });
  });

  it(
    "primitives emit correctly-shaped ActionEvents with raw timestamps",
    async () => {
      const before = Date.now();
      const session = await BrowserSession.open(browser, { sessionId, db, deviceType: "desktop" });
      try {
        await session.navigate(`${site.baseUrl}/`, "Start at the home page.");
        await session.click("#nav-horses", "Follow the horses link.");
        const state = await session.readPageState("See where we landed.");
        expect(state.title).toBe("Horses");
        expect(state.url).toBe(`${site.baseUrl}/horses`);
        expect(state.ariaSnapshot).toContain("Our Horses");
      } finally {
        await session.close();
      }

      const events = db.getEventsBySession(sessionId);
      const types = events.map((e) => e.actionType);
      expect(types).toContain("navigate");
      expect(types).toContain("click");
      expect(types).toContain("read-page");
      for (const e of events) {
        expect(e.sessionId).toBe(sessionId);
        expect(e.timestamp).toBeGreaterThanOrEqual(before);
        expect(e.timestamp).toBeLessThanOrEqual(Date.now());
        expect(e.reasoning.length).toBeGreaterThan(0);
      }
      const nav = events.find((e) => e.actionType === "navigate");
      expect(nav?.target).toBe(`${site.baseUrl}/`);
      const click = events.find((e) => e.actionType === "click");
      expect(click?.target).toBe("#nav-horses");
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    "console errors and HTTP failures land in the event stream",
    async () => {
      const session = await BrowserSession.open(browser, { sessionId, db, deviceType: "desktop" });
      try {
        await session.navigate(`${site.baseUrl}/broken`, "Visit the broken page.");
        await session.navigate(`${site.baseUrl}/horses`, "Go to the horses page.");
        await session.click("#load-more", "Ask for more horses.");
        // The 500 response arrives async; give the listener a beat.
        await session.page.waitForResponse((r) => r.url().includes("/api/horses/page2"));
      } finally {
        await session.close();
      }

      const events = db.getEventsBySession(sessionId);
      const consoleErrors = events.filter((e) => e.actionType === "console-error");
      expect(consoleErrors.length).toBeGreaterThanOrEqual(1);
      expect(consoleErrors[0]?.reasoning).toContain("widget failed to mount");
      expect(consoleErrors[0]?.target).toContain("/broken");

      const httpFailures = events.filter((e) => e.actionType === "http-failure");
      expect(httpFailures.some((e) => e.target.startsWith("500 GET"))).toBe(true);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    "fill logs the selector but never the value",
    async () => {
      const session = await BrowserSession.open(browser, { sessionId, db, deviceType: "desktop" });
      try {
        await session.navigate(`${site.baseUrl}/signup`, "Go sign up.");
        await session.fill("#signup-name", "SECRET-VALUE-123", "Enter my name.");
      } finally {
        await session.close();
      }
      const events = db.getEventsBySession(sessionId);
      const fill = events.find((e) => e.actionType === "fill");
      expect(fill?.target).toBe("#signup-name");
      for (const e of events) {
        expect(e.target).not.toContain("SECRET-VALUE-123");
        expect(e.reasoning).not.toContain("SECRET-VALUE-123");
      }
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    "a failed action logs the attempt plus an action-error event and rethrows",
    async () => {
      const session = await BrowserSession.open(browser, { sessionId, db, deviceType: "desktop" });
      session.page.setDefaultTimeout(500);
      try {
        await session.navigate(`${site.baseUrl}/`, "Start at home.");
        await expect(
          session.click("#does-not-exist", "Click something missing."),
        ).rejects.toThrow();
      } finally {
        await session.close();
      }
      const events = db.getEventsBySession(sessionId);
      const attempt = events.find((e) => e.actionType === "click");
      expect(attempt?.target).toBe("#does-not-exist");
      const failure = events.find((e) => e.actionType === "action-error");
      expect(failure?.target).toBe("#does-not-exist");
      expect(failure?.reasoning).toContain("Action failed");
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    "storageState seeds cookies into the session's context",
    async () => {
      const session = await BrowserSession.open(browser, {
        sessionId,
        db,
        deviceType: "desktop",
        storageState: {
          cookies: [
            {
              name: "drover_seeded",
              value: "yes",
              domain: "127.0.0.1",
              path: "/",
              expires: Math.floor(Date.now() / 1000) + 3600,
              httpOnly: false,
              secure: false,
              sameSite: "Lax",
            },
          ],
          origins: [],
        },
      });
      try {
        await session.navigate(`${site.baseUrl}/`, "Open home with a seeded session.");
        const cookie = await session.page.evaluate(() => document.cookie);
        expect(cookie).toContain("drover_seeded=yes");
      } finally {
        await session.close();
      }
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    "captureScreenshot writes a png and returns its path",
    async () => {
      const session = await BrowserSession.open(browser, { sessionId, db, deviceType: "mobile" });
      try {
        await session.navigate(`${site.baseUrl}/`, "Open home to screenshot it.");
        const dir = `${process.env.TEMP ?? "."}/drover-test-screenshots`;
        const file = await captureScreenshot(session.page, dir, "home page!");
        expect(file).toBeDefined();
        expect(file).toMatch(/home-page-.*\.png$/);
      } finally {
        await session.close();
      }
    },
    INTEGRATION_TIMEOUT,
  );
});
