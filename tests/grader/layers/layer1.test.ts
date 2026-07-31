import { describe, expect, it } from "vitest";
import { layer1 } from "../../../src/grader/layers/layer1.js";
import type { Case, GraderPack } from "../../../src/grader/types.js";

const dummyPack: GraderPack = {
  appName: "toy-app",
  rubrics: {},
  loadCases: () => [],
  dataPolicy: "synthetic-only",
};

function makeCase(output: unknown): Case {
  return {
    id: "case-1",
    gradingRunId: "run-1",
    input: { prompt: "irrelevant to Layer 1" },
    output,
    rubric: "none",
    createdAt: 0,
  };
}

function run(output: unknown) {
  return layer1.run({ gradingCase: makeCase(output), pack: dummyPack });
}

describe("layer1 (deterministic schema/format checks)", () => {
  it("passes a well-formed, non-empty object output", () => {
    const outcome = run({ text: "Thanks for volunteering!" });
    expect(outcome.status).toBe("pass");
    expect(outcome.checks).toHaveLength(3);
    expect(outcome.checks.every((c) => c.value === true)).toBe(true);
  });

  it("fails on a null output (present and non-empty both fail)", () => {
    const outcome = run(null);
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-present")?.value).toBe(false);
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(false);
    expect(outcome.checks.find((c) => c.name === "output-json-serializable")?.value).toBe(true);
  });

  it("fails on an undefined output", () => {
    const outcome = run(undefined);
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-present")?.value).toBe(false);
  });

  it("fails on an empty string", () => {
    const outcome = run("");
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(false);
  });

  it("fails on a blank (whitespace-only) string", () => {
    const outcome = run("   \n\t");
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(false);
  });

  it("fails on an empty array", () => {
    const outcome = run([]);
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(false);
  });

  it("fails on an empty object", () => {
    const outcome = run({});
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(false);
  });

  it("fails on a circular-reference object (not JSON-serializable), even though it has keys", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately circular to exercise the serializability check
    const circular: any = { label: "self-referencing" };
    circular.self = circular;
    const outcome = run(circular);
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-json-serializable")?.value).toBe(false);
    expect(outcome.checks.find((c) => c.name === "output-present")?.value).toBe(true);
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(true);
  });

  it("passes falsy-but-present primitives (0, false) without flagging them non-empty-false", () => {
    expect(run(0).status).toBe("pass");
    expect(run(false).status).toBe("pass");
  });

  it("passes a non-empty array and non-empty string", () => {
    expect(run([1, 2, 3]).status).toBe("pass");
    expect(run("a real response").status).toBe("pass");
  });
});
