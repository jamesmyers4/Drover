/**
 * Screenshot capture utility. Deliberately not wired into every action —
 * screenshots are pulled only at the moment a finding is flagged
 * (CONTEXT.md "Visual evidence"). Session 3 calls this when writing an
 * in-session finding; the analyst tier reuses it for cross-session evidence.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

/**
 * Captures a full-page PNG into `dir` and returns the file path (the value
 * stored in a finding's `screenshotPath`). Never throws: evidence capture
 * failing must not escalate a finding into a crash — returns undefined and
 * the finding simply ships without a screenshot.
 */
export async function captureScreenshot(
  page: Page,
  dir: string,
  name: string,
): Promise<string | undefined> {
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sanitize(name)}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return undefined;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}
