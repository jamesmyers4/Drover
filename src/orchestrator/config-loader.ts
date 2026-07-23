/**
 * Loads a `sim.config.ts` or domain-pack `.ts` module by path for the CLI
 * (CLAUDE.md Session 4: "Config is typed TypeScript... not JSON/YAML").
 * Both are plain modules with a default export of the expected shape — no
 * special registration required beyond a TS-aware loader already being
 * active in the process (see src/cli/index.ts, which registers tsx before
 * calling either loader).
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

export class ConfigLoadError extends Error {
  constructor(label: string, filePath: string, reason: string) {
    super(`Failed to load ${label} from "${filePath}": ${reason}`);
    this.name = "ConfigLoadError";
  }
}

export async function loadDefaultExport<T>(filePath: string, label: string): Promise<T> {
  const absolutePath = path.resolve(process.cwd(), filePath);
  let mod: { default?: T };
  try {
    mod = (await import(pathToFileURL(absolutePath).href)) as { default?: T };
  } catch (err) {
    throw new ConfigLoadError(label, filePath, err instanceof Error ? err.message : String(err));
  }
  if (mod.default === undefined) {
    throw new ConfigLoadError(label, filePath, "module has no default export");
  }
  return mod.default;
}
