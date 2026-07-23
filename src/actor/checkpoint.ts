/**
 * Checkpoint detector DSL — evaluated against the live page after each
 * actor action (CONTEXT.md "Persona & domain pack schema": `Checkpoint.detector`
 * format finalized here, per CLAUDE.md Session 3). Three matcher kinds:
 *
 *   url:<substring>       — page.url() contains the substring
 *   selector:<css>        — a matching element exists on the page
 *   text:<substring>       — the page's visible body text contains the substring (case-insensitive)
 *
 * Domain packs never see anything beyond this string — detectors are our
 * instrumentation, not something exposed to the persona/model.
 */

import type { Page } from "playwright";
import type { Checkpoint } from "../types/index.js";

export type CheckpointMatcherKind = "url" | "selector" | "text";

export interface ParsedCheckpointDetector {
  kind: CheckpointMatcherKind;
  value: string;
}

export function parseCheckpointDetector(detector: string): ParsedCheckpointDetector {
  const idx = detector.indexOf(":");
  if (idx === -1) {
    throw new Error(`Invalid checkpoint detector (missing "kind:" prefix): "${detector}"`);
  }
  const kind = detector.slice(0, idx).trim();
  const value = detector.slice(idx + 1).trim();
  if (kind !== "url" && kind !== "selector" && kind !== "text") {
    throw new Error(
      `Unknown checkpoint detector kind "${kind}" in "${detector}" (expected url:, selector:, or text:)`,
    );
  }
  if (!value) {
    throw new Error(`Checkpoint detector "${detector}" has an empty matcher value`);
  }
  return { kind, value };
}

export async function evaluateCheckpointDetector(detector: string, page: Page): Promise<boolean> {
  const { kind, value } = parseCheckpointDetector(detector);
  switch (kind) {
    case "url":
      return page.url().includes(value);
    case "selector":
      return (await page.locator(value).count()) > 0;
    case "text": {
      const body = await page.locator("body").innerText();
      return body.toLowerCase().includes(value.toLowerCase());
    }
  }
}

/** Returns the ids of every checkpoint currently satisfied by the live page. */
export async function evaluateCheckpoints(
  checkpoints: Checkpoint[],
  page: Page,
): Promise<string[]> {
  const hits: string[] = [];
  for (const checkpoint of checkpoints) {
    if (await evaluateCheckpointDetector(checkpoint.detector, page)) {
      hits.push(checkpoint.id);
    }
  }
  return hits;
}
