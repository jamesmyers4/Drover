/**
 * Persona-agnostic browser session wrapper: one isolated Playwright context
 * per persona-session, action primitives that each emit an `ActionEvent`
 * (raw timestamp) to SQLite, and passive listeners that log console errors
 * and HTTP failures into the same event stream. Session 3's actor loop and
 * Session 7's Stampede replayer both drive the browser only through this.
 *
 * Secrets discipline: auth state (cookies/tokens) enters via `storageState`
 * into the browser context only. Fill values are never written to the event
 * log — only the target selector is.
 */

import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { DroverDb } from "../db/database.js";
import type { TreelineStorageState } from "../treeline/adapter.js";
import { contextOptionsForDevice, type DeviceType } from "./device.js";

/** Action types emitted by the primitives. */
export type PrimitiveActionType = "navigate" | "click" | "fill" | "read-page";
/** Action types emitted by passive observation listeners. */
export type ObservationActionType = "console-error" | "page-error" | "http-failure";
/** Emitted when a primitive throws (timeout, missing selector, ...). */
export type ActionErrorType = "action-error";

const MAX_OBSERVED_TEXT = 300;

export interface BrowserSessionOptions {
  /** Must already exist as a sessions row (FK on action_events). */
  sessionId: string;
  db: DroverDb;
  deviceType: DeviceType;
  /** treeLine-captured auth state; seeds the context, never prompt content. */
  storageState?: TreelineStorageState;
  /**
   * Log responses with status >= this as http-failure events.
   * @default 400 — log raw, filter later; findings (S3) only use 5xx.
   */
  httpFailureThreshold?: number;
}

/** Compact page representation — the actor tier's "perceive" input (S3). */
export interface PageSummary {
  url: string;
  title: string;
  /** Playwright aria snapshot of the body — roles + accessible names. */
  ariaSnapshot: string;
  eventId: string;
}

export async function launchBrowser(options?: { headless?: boolean }): Promise<Browser> {
  return chromium.launch({ headless: options?.headless ?? true });
}

export class BrowserSession {
  private constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly opts: BrowserSessionOptions,
  ) {}

  private closed = false;

  static async open(browser: Browser, opts: BrowserSessionOptions): Promise<BrowserSession> {
    const context = await browser.newContext({
      ...contextOptionsForDevice(opts.deviceType),
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    const page = await context.newPage();
    const session = new BrowserSession(context, page, opts);
    session.wireObservationListeners();
    return session;
  }

  /** Every event funnels through here so the raw-timestamp rule holds. */
  private emit(
    actionType: PrimitiveActionType | ObservationActionType | ActionErrorType,
    target: string,
    reasoning: string,
    timestamp: number,
    checkpointId?: string,
  ): string {
    return this.opts.db.insertActionEvent({
      sessionId: this.opts.sessionId,
      timestamp,
      actionType,
      target,
      reasoning,
      ...(checkpointId !== undefined && { checkpointId }),
    });
  }

  private wireObservationListeners(): void {
    const threshold = this.opts.httpFailureThreshold ?? 400;
    this.page.on("console", (msg) => {
      if (msg.type() !== "error" || this.closed) return;
      this.safeEmit(
        "console-error",
        this.page.url(),
        `Console error observed: ${truncate(msg.text())}`,
      );
    });
    this.page.on("pageerror", (err) => {
      if (this.closed) return;
      this.safeEmit(
        "page-error",
        this.page.url(),
        `Uncaught page exception observed: ${truncate(err.message)}`,
      );
    });
    this.page.on("response", (response) => {
      if (this.closed || response.status() < threshold) return;
      const req = response.request();
      this.safeEmit(
        "http-failure",
        `${response.status()} ${req.method()} ${response.url()}`,
        "HTTP failure response observed.",
      );
    });
    this.page.on("requestfailed", (request) => {
      if (this.closed) return;
      this.safeEmit(
        "http-failure",
        `FAILED ${request.method()} ${request.url()}`,
        `Network request failed: ${truncate(request.failure()?.errorText ?? "unknown error")}`,
      );
    });
  }

  /** Listener-path insert — an observer failing must never kill the session. */
  private safeEmit(actionType: ObservationActionType, target: string, reasoning: string): void {
    try {
      this.emit(actionType, target, reasoning, Date.now());
    } catch {
      // Db closed mid-teardown or similar; drop the observation.
    }
  }

  // --- action primitives ---

  async navigate(url: string, reasoning: string, checkpointId?: string): Promise<string> {
    return this.performAction("navigate", url, reasoning, checkpointId, async () => {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
    });
  }

  async click(selector: string, reasoning: string, checkpointId?: string): Promise<string> {
    return this.performAction("click", selector, reasoning, checkpointId, async () => {
      await this.page.locator(selector).first().click();
    });
  }

  async fill(
    selector: string,
    value: string,
    reasoning: string,
    checkpointId?: string,
  ): Promise<string> {
    // `value` is deliberately absent from the emitted event.
    return this.performAction("fill", selector, reasoning, checkpointId, async () => {
      await this.page.locator(selector).first().fill(value);
    });
  }

  async readPageState(reasoning: string, checkpointId?: string): Promise<PageSummary> {
    const timestamp = Date.now();
    const url = this.page.url();
    const title = await this.page.title();
    const ariaSnapshot = await this.page.locator("body").ariaSnapshot();
    const eventId = this.emit("read-page", url, reasoning, timestamp, checkpointId);
    return { url, title, ariaSnapshot, eventId };
  }

  /**
   * Runs the action, then logs it with the timestamp taken when it started.
   * A failed action still logs the attempt, plus an `action-error` event, and
   * rethrows — the caller decides whether that's retryable or a hard stop.
   */
  private async performAction(
    actionType: PrimitiveActionType,
    target: string,
    reasoning: string,
    checkpointId: string | undefined,
    act: () => Promise<void>,
  ): Promise<string> {
    const timestamp = Date.now();
    try {
      await act();
    } catch (err) {
      this.emit(actionType, target, reasoning, timestamp, checkpointId);
      this.emit(
        "action-error",
        target,
        `Action failed: ${truncate(err instanceof Error ? err.message : String(err))}`,
        Date.now(),
      );
      throw err;
    }
    return this.emit(actionType, target, reasoning, timestamp, checkpointId);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.context.close();
  }
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_OBSERVED_TEXT ? `${oneLine.slice(0, MAX_OBSERVED_TEXT)}…` : oneLine;
}
