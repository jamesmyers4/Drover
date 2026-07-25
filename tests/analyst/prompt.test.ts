import { describe, expect, it } from "vitest";
import type { SessionDigest } from "../../src/analyst/digest.js";
import { buildAnalystUserPrompt } from "../../src/analyst/prompt.js";

function makeDigest(overrides?: Partial<SessionDigest>): SessionDigest {
  return {
    sessionId: "s1",
    personaId: "p1",
    goalId: "signup-flow",
    status: "completed",
    actionCount: 3,
    checkpointReachTimesMs: { "cp-signup-complete": 4200 },
    findingsSummary: [],
    actionsSummary: [],
    ...overrides,
  };
}

describe("buildAnalystUserPrompt checkpoint context", () => {
  it("renders a checkpoint's description and owning goal when context is supplied", () => {
    const prompt = buildAnalystUserPrompt([makeDigest()], {
      "cp-signup-complete": { goalId: "signup-flow", description: "User submits the signup form" },
    });

    expect(prompt).toContain(
      'cp-signup-complete ("User submits the signup form", goal: signup-flow): 4200ms',
    );
  });

  it("falls back to the bare checkpoint id when no context is supplied", () => {
    const prompt = buildAnalystUserPrompt([makeDigest()]);

    expect(prompt).toContain("cp-signup-complete: 4200ms");
    expect(prompt).not.toContain("goal:");
  });

  it("falls back to the bare checkpoint id when context doesn't cover this particular id", () => {
    const prompt = buildAnalystUserPrompt([makeDigest()], {
      "some-other-checkpoint": { goalId: "other-flow", description: "Unrelated." },
    });

    expect(prompt).toContain("cp-signup-complete: 4200ms");
  });
});
