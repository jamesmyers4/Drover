import { describe, expect, it } from "vitest";
import { ConfigLoadError, loadDefaultExport } from "../../src/orchestrator/config-loader.js";

describe("loadDefaultExport", () => {
  it("loads a module's default export", async () => {
    const result = await loadDefaultExport<{ hello: string }>(
      "tests/fixtures/config-loader-good.ts",
      "test module",
    );
    expect(result).toEqual({ hello: "world" });
  });

  it("throws ConfigLoadError when the module has no default export", async () => {
    await expect(
      loadDefaultExport("tests/fixtures/config-loader-bad.ts", "test module"),
    ).rejects.toThrow(ConfigLoadError);
  });

  it("throws ConfigLoadError when the file doesn't exist", async () => {
    await expect(
      loadDefaultExport("tests/fixtures/does-not-exist.ts", "test module"),
    ).rejects.toThrow(ConfigLoadError);
  });
});
