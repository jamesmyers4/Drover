import { describe, expect, it } from "vitest";
import {
  BatchAnalystProvider,
  createAnalystProvider,
  DEFAULT_ANALYST_MODEL,
  ScriptedAnalystProvider,
} from "../../src/analyst/provider.js";

describe("createAnalystProvider", () => {
  it("builds a BatchAnalystProvider for provider 'anthropic'", () => {
    const provider = createAnalystProvider({ provider: "anthropic", model: DEFAULT_ANALYST_MODEL });
    expect(provider).toBeInstanceOf(BatchAnalystProvider);
    expect(provider.model).toBe(DEFAULT_ANALYST_MODEL);
  });

  it("rejects an unsupported provider", () => {
    expect(() => createAnalystProvider({ provider: "not-a-real-provider", model: "x" })).toThrow(
      /Unsupported analyst-tier provider/,
    );
  });
});

describe("ScriptedAnalystProvider", () => {
  it("returns the scripted findings and a fixed cost", async () => {
    const provider = new ScriptedAnalystProvider(
      [
        {
          type: "recurring-dead-end",
          severity: "medium",
          description: "Several sessions land on /help with no way forward.",
          sessionIds: ["s1", "s2"],
          route: "/help",
        },
      ],
      0.01,
    );

    const result = await provider.analyze({ systemPrompt: "s", userPrompt: "u" });
    expect(result.findings).toHaveLength(1);
    expect(result.usage.costUsd).toBe(0.01);
  });
});
