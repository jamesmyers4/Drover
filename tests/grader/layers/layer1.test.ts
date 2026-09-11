import { describe, expect, it } from "vitest";
import { GraderDb } from "../../../src/grader/db.js";
import { layer1 } from "../../../src/grader/layers/layer1.js";
import type { Case, GraderPack } from "../../../src/grader/types.js";

const dummyPack: GraderPack = {
  appName: "toy-app",
  rubrics: {},
  loadCases: () => [],
  dataPolicy: "synthetic-only",
};

/** Layer 1 never touches `db`/`now` — a shared in-memory stand-in is enough to satisfy `LayerRunContext`'s shape (Grader Session 6). */
const db = new GraderDb(":memory:");
const now = () => 0;

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

async function run(output: unknown) {
  return await layer1.run({ gradingCase: makeCase(output), pack: dummyPack, db, now });
}

describe("layer1 (deterministic schema/format checks)", () => {
  it("passes a well-formed, non-empty object output", async () => {
    const outcome = await run({ text: "Thanks for volunteering!" });
    expect(outcome.status).toBe("pass");
    expect(outcome.checks).toHaveLength(3);
    expect(outcome.checks.every((c) => c.value === true)).toBe(true);
  });

  it("fails on a null output (present and non-empty both fail)", async () => {
    const outcome = await run(null);
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-present")?.value).toBe(false);
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(false);
    expect(outcome.checks.find((c) => c.name === "output-json-serializable")?.value).toBe(true);
  });

  it("fails on an undefined output", async () => {
    const outcome = await run(undefined);
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-present")?.value).toBe(false);
  });

  it("fails on an empty string", async () => {
    const outcome = await run("");
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(false);
  });

  it("fails on a blank (whitespace-only) string", async () => {
    const outcome = await run("   \n\t");
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(false);
  });

  it("fails on an empty array", async () => {
    const outcome = await run([]);
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(false);
  });

  it("fails on an empty object", async () => {
    const outcome = await run({});
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(false);
  });

  it("fails on a circular-reference object (not JSON-serializable), even though it has keys", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately circular to exercise the serializability check
    const circular: any = { label: "self-referencing" };
    circular.self = circular;
    const outcome = await run(circular);
    expect(outcome.status).toBe("fail");
    expect(outcome.checks.find((c) => c.name === "output-json-serializable")?.value).toBe(false);
    expect(outcome.checks.find((c) => c.name === "output-present")?.value).toBe(true);
    expect(outcome.checks.find((c) => c.name === "output-non-empty")?.value).toBe(true);
  });

  it("passes falsy-but-present primitives (0, false) without flagging them non-empty-false", async () => {
    expect((await run(0)).status).toBe("pass");
    expect((await run(false)).status).toBe("pass");
  });

  it("passes a non-empty array and non-empty string", async () => {
    expect((await run([1, 2, 3])).status).toBe("pass");
    expect((await run("a real response")).status).toBe("pass");
  });
});
