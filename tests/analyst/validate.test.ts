import { describe, expect, it } from "vitest";
import { isValidationError, validateRawFinding } from "../../src/analyst/validate.js";

describe("validateRawFinding", () => {
  const known = new Set(["s1", "s2"]);

  it("accepts a well-formed finding and trims/filters session ids to known ones", () => {
    const result = validateRawFinding(
      {
        type: "repeated-stumble-route",
        severity: "high",
        description: "  Multiple sessions got stuck on /schedule/edit.  ",
        sessionIds: ["s1", "s2", "s-hallucinated"],
        route: " /schedule/edit ",
      },
      known,
    );

    expect(isValidationError(result)).toBe(false);
    if (isValidationError(result)) throw new Error("unreachable");
    expect(result).toEqual({
      type: "repeated-stumble-route",
      severity: "high",
      description: "Multiple sessions got stuck on /schedule/edit.",
      sessionIds: ["s1", "s2"],
      route: "/schedule/edit",
    });
  });

  it("rejects an invalid type", () => {
    const result = validateRawFinding(
      {
        type: "not-a-real-type",
        severity: "low",
        description: "x",
        sessionIds: ["s1"],
        route: "r",
      },
      known,
    );
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("unreachable");
    expect(result.error).toMatch(/type/);
  });

  it("rejects an invalid severity", () => {
    const result = validateRawFinding(
      {
        type: "duplicate-label",
        severity: "catastrophic",
        description: "x",
        sessionIds: ["s1"],
        route: "r",
      },
      known,
    );
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("unreachable");
    expect(result.error).toMatch(/severity/);
  });

  it("rejects a missing or empty description", () => {
    const result = validateRawFinding(
      {
        type: "duplicate-label",
        severity: "low",
        description: "  ",
        sessionIds: ["s1"],
        route: "r",
      },
      known,
    );
    expect(isValidationError(result)).toBe(true);
  });

  it("rejects a missing or empty route", () => {
    const result = validateRawFinding(
      { type: "duplicate-label", severity: "low", description: "x", sessionIds: ["s1"], route: "" },
      known,
    );
    expect(isValidationError(result)).toBe(true);
  });

  it("rejects sessionIds that isn't an array", () => {
    const result = validateRawFinding(
      { type: "duplicate-label", severity: "low", description: "x", sessionIds: "s1", route: "r" },
      known,
    );
    expect(isValidationError(result)).toBe(true);
  });

  it("rejects when every session id is unknown (hallucinated)", () => {
    const result = validateRawFinding(
      {
        type: "duplicate-label",
        severity: "low",
        description: "x",
        sessionIds: ["ghost-1", "ghost-2"],
        route: "r",
      },
      known,
    );
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("unreachable");
    expect(result.error).toMatch(/sessionIds/);
  });
});
