/**
 * Compare-or-regenerate helper for checked-in golden files (TESTING.md
 * Session 3) — same `UPDATE_GOLDEN=1` convention treeLine's own golden-master
 * tests used. Comparing serialized strings (not `toEqual` on the object)
 * means a failure prints a real, readable line-by-line diff instead of an
 * opaque "objects not equal."
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

const GOLDEN_DIR = path.join(import.meta.dirname, "__golden__");

export function expectMatchesGolden(name: string, actual: unknown): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const serialized = `${JSON.stringify(actual, null, 2)}\n`;

  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, serialized);
    return;
  }

  if (!existsSync(file)) {
    throw new Error(
      `Golden file ${file} does not exist. Run \`UPDATE_GOLDEN=1 npm test\` to create it.`,
    );
  }
  const expected = readFileSync(file, "utf8");
  expect(serialized).toBe(expected);
}
