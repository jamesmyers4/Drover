import { describe, expect, it } from "vitest";
import { GraderDb } from "../../src/grader/db.js";
import type { LayerImplementation, LayerRegistry } from "../../src/grader/layer.js";
import { layer1 } from "../../src/grader/layers/layer1.js";
import { ScriptedGraderProvider } from "../../src/grader/provider.js";
import {
  assertDistinctModelFamilies,
  assertEscalationDispatchAllowed,
  DuplicateModelFamilyError,
  InsufficientJudgesError,
  resolveLayerDispatchOrder,
  runGradingRun,
} from "../../src/grader/scheduler.js";
import type { GraderPack, LayerId, Rubric } from "../../src/grader/types.js";

const noneRubric: Rubric = { key: "none", description: "Not consumed by Layer 1.", checks: [] };

function makeToyPack(overrides?: Partial<GraderPack>): GraderPack {
  return {
    appName: "toy-app",
    rubrics: { none: noneRubric },
    loadCases: () => [{ input: { prompt: "hi" }, output: { text: "hello!" }, rubric: "none" }],
    dataPolicy: "synthetic-only",
    ...overrides,
  };
}

/** A fixed-outcome layer implementation for exercising DAG/skip logic without needing a real model. */
function makeFixedLayer(layerId: LayerId, status: "pass" | "fail"): LayerImplementation {
  return {
    layerId,
    run: () => ({
      status,
      checks: [
        { name: `layer-${layerId}-check`, value: status === "pass", reasoning: "fixed for test" },
      ],
    }),
  };
}

describe("resolveLayerDispatchOrder", () => {
  it("returns dispatch-candidate layers in ascending id order when there are no declared prerequisites", () => {
    const pack = makeToyPack();
    const registry: LayerRegistry = {
      1: layer1,
      4: makeFixedLayer(4, "pass"),
      2: makeFixedLayer(2, "pass"),
    };
    expect(resolveLayerDispatchOrder(pack, registry)).toEqual([1, 2, 4]);
  });

  it("orders a lower-numbered layer after a higher-numbered layer it depends on (real DAG-awareness, not just id sort)", () => {
    const pack = makeToyPack({
      layers: {
        2: {
          requires: [{ layerId: 4, justification: "Structurally meaningless without layer 4." }],
        },
      },
    });
    const registry: LayerRegistry = {
      1: layer1,
      2: makeFixedLayer(2, "pass"),
      4: makeFixedLayer(4, "pass"),
    };
    expect(resolveLayerDispatchOrder(pack, registry)).toEqual([1, 4, 2]);
  });

  it("excludes a layer explicitly disabled via layers[id].enabled === false from the dispatch order", () => {
    const pack = makeToyPack({ layers: { 2: { enabled: false } } });
    const registry: LayerRegistry = { 1: layer1, 2: makeFixedLayer(2, "pass") };
    expect(resolveLayerDispatchOrder(pack, registry)).toEqual([1]);
  });

  it("ignores a requires edge pointing at a layer id outside the dispatch-candidate set", () => {
    const pack = makeToyPack({
      layers: {
        1: { requires: [{ layerId: 5, justification: "layer 5 isn't implemented yet" }] },
      },
    });
    const registry: LayerRegistry = { 1: layer1 };
    // Layer 5 isn't in the registry, so it can't participate in ordering — layer 1 still dispatches.
    expect(resolveLayerDispatchOrder(pack, registry)).toEqual([1]);
  });

  it("throws when the dispatch-candidate subset itself has a cycle (defensive — validateGraderPack should already catch this on a real pack)", () => {
    const pack = makeToyPack({
      layers: {
        2: { requires: [{ layerId: 3, justification: "x" }] },
        3: { requires: [{ layerId: 2, justification: "y" }] },
      },
    });
    const registry: LayerRegistry = { 2: makeFixedLayer(2, "pass"), 3: makeFixedLayer(3, "pass") };
    expect(() => resolveLayerDispatchOrder(pack, registry)).toThrow(/cycle/);
  });
});

describe("runGradingRun", () => {
  it("runs a full Grading Run against Layer 1 only, writing real rows to grader.sqlite", async () => {
    const db = new GraderDb(":memory:");
    const pack = makeToyPack({
      loadCases: () => [
        { input: { prompt: "a" }, output: { text: "Thanks for volunteering!" }, rubric: "none" },
        { input: { prompt: "b" }, output: "", rubric: "none" },
        { input: { prompt: "c" }, output: null, rubric: "none" },
      ],
    });

    const result = await runGradingRun({ db, pack });

    expect(result.status).toBe("completed");
    expect(result.casesProcessed).toBe(3);
    expect(result.tasksPassed).toBe(1);
    expect(result.tasksFailed).toBe(2);
    expect(result.tasksSkipped).toBe(0);

    const run = db.getGradingRun(result.gradingRunId);
    expect(run?.status).toBe("completed");
    expect(run?.endedAt).toBeDefined();
    expect(run?.packConfig.appName).toBe("toy-app");

    const cases = db.getCasesByGradingRun(result.gradingRunId);
    expect(cases).toHaveLength(3);
    for (const c of cases) {
      const tasks = db.getTasksByCase(c.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.layerId).toBe(1);
      expect(["pass", "fail"]).toContain(tasks[0]?.status);
    }
    db.close();
  });

  it("processes an empty case list without error", async () => {
    const db = new GraderDb(":memory:");
    const pack = makeToyPack({ loadCases: () => [] });
    const result = await runGradingRun({ db, pack });
    expect(result.status).toBe("completed");
    expect(result).toMatchObject({
      casesProcessed: 0,
      tasksPassed: 0,
      tasksFailed: 0,
      tasksSkipped: 0,
    });
    db.close();
  });

  it("skips a layer whose declared prerequisite Task did not pass, carrying the justification string", async () => {
    const db = new GraderDb(":memory:");
    const pack = makeToyPack({
      layers: {
        3: {
          requires: [
            { layerId: 2, justification: "Structurally meaningless without layer 2 passing." },
          ],
        },
      },
    });
    const registry: LayerRegistry = { 2: makeFixedLayer(2, "fail"), 3: makeFixedLayer(3, "pass") };

    const result = await runGradingRun({ db, pack, layers: registry });
    expect(result.tasksFailed).toBe(1);
    expect(result.tasksSkipped).toBe(1);

    const [c] = db.getCasesByGradingRun(result.gradingRunId);
    const tasks = db.getTasksByCase(c?.id ?? "");
    const layer3Task = tasks.find((t) => t.layerId === 3);
    expect(layer3Task?.status).toBe("skipped");
    expect(layer3Task?.skippedReason).toBe("Structurally meaningless without layer 2 passing.");
    db.close();
  });

  it("dispatches a layer normally (not skipped) when its declared prerequisite passed", async () => {
    const db = new GraderDb(":memory:");
    const pack = makeToyPack({
      layers: { 3: { requires: [{ layerId: 2, justification: "needs layer 2" }] } },
    });
    const registry: LayerRegistry = { 2: makeFixedLayer(2, "pass"), 3: makeFixedLayer(3, "pass") };

    const result = await runGradingRun({ db, pack, layers: registry });
    expect(result.tasksSkipped).toBe(0);
    expect(result.tasksPassed).toBe(2);
    db.close();
  });

  it("cascades a skip through a chain of dependents", async () => {
    const db = new GraderDb(":memory:");
    const pack = makeToyPack({
      layers: {
        3: { requires: [{ layerId: 2, justification: "needs 2" }] },
        4: { requires: [{ layerId: 3, justification: "needs 3" }] },
      },
    });
    const registry: LayerRegistry = {
      2: makeFixedLayer(2, "fail"),
      3: makeFixedLayer(3, "pass"),
      4: makeFixedLayer(4, "pass"),
    };

    const result = await runGradingRun({ db, pack, layers: registry });
    expect(result.tasksFailed).toBe(1);
    expect(result.tasksSkipped).toBe(2);

    const [c] = db.getCasesByGradingRun(result.gradingRunId);
    const tasks = db.getTasksByCase(c?.id ?? "");
    expect(tasks.find((t) => t.layerId === 3)?.status).toBe("skipped");
    expect(tasks.find((t) => t.layerId === 4)?.status).toBe("skipped");
    db.close();
  });

  it("never inserts a Task row for a layer explicitly disabled via enabled: false", async () => {
    const db = new GraderDb(":memory:");
    const pack = makeToyPack({ layers: { 2: { enabled: false } } });
    const registry: LayerRegistry = { 1: layer1, 2: makeFixedLayer(2, "pass") };

    const result = await runGradingRun({ db, pack, layers: registry });
    const [c] = db.getCasesByGradingRun(result.gradingRunId);
    const tasks = db.getTasksByCase(c?.id ?? "");
    expect(tasks.map((t) => t.layerId).sort()).toEqual([1]);
    db.close();
  });

  it("never inserts a grading_runs row for a pack that fails static validation", async () => {
    const db = new GraderDb(":memory:");
    const pack = makeToyPack({
      loadCases: () => [{ input: {}, output: {}, rubric: "typo-d-rubric-key" }],
    });

    await expect(runGradingRun({ db, pack })).rejects.toThrow();

    // biome-ignore lint/suspicious/noExplicitAny: reaching past GraderDb's public API to assert nothing was written
    const rawDb = (db as any).db as { prepare: (sql: string) => { all: () => unknown[] } };
    expect(rawDb.prepare("SELECT * FROM grading_runs").all()).toEqual([]);
    db.close();
  });

  it("isolates a layer implementation's thrown error as that Task's own fail — the run itself completes, not crashes (Q5's coverage-over-cost guarantee, applied at Task granularity)", async () => {
    const db = new GraderDb(":memory:");
    const throwingLayer: LayerImplementation = {
      layerId: 2,
      run: () => {
        throw new Error("judge unreachable");
      },
    };
    const pack = makeToyPack({
      layers: { 3: { requires: [{ layerId: 2, justification: "needs layer 2 to pass" }] } },
    });
    const registry: LayerRegistry = { 2: throwingLayer, 3: makeFixedLayer(3, "pass") };

    const result = await runGradingRun({ db, pack, layers: registry });
    expect(result.status).toBe("completed");
    expect(result.tasksFailed).toBe(1);
    // Layer 3's declared prerequisite on layer 2 is unmet (the caught throw counts
    // as "not pass," same as an ordinary fail) — the cascade still applies.
    expect(result.tasksSkipped).toBe(1);

    const [c] = db.getCasesByGradingRun(result.gradingRunId);
    const tasks = db.getTasksByCase(c?.id ?? "");
    const layer2Task = tasks.find((t) => t.layerId === 2);
    expect(layer2Task?.status).toBe("fail");
    expect(layer2Task?.checks[0]?.reasoning).toContain("judge unreachable");
    db.close();
  });

  it("marks the grading run crashed and rethrows on a genuine orchestration-level fault (a DB write itself throwing)", async () => {
    class ThrowingInsertCaseDb extends GraderDb {
      override insertCase(): void {
        throw new Error("disk full");
      }
    }
    const db = new ThrowingInsertCaseDb(":memory:");
    const pack = makeToyPack();

    await expect(runGradingRun({ db, pack })).rejects.toThrow("disk full");

    // biome-ignore lint/suspicious/noExplicitAny: reaching past GraderDb's public API to inspect the row written before the throw
    const rawDb = (db as any).db as { prepare: (sql: string) => { all: () => unknown[] } };
    const rows = rawDb.prepare("SELECT id, status FROM grading_runs").all() as {
      id: string;
      status: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("crashed");
    db.close();
  });
});

describe("assertDistinctModelFamilies", () => {
  it("passes when every judge has a distinct modelFamily", () => {
    expect(() =>
      assertDistinctModelFamilies([{ modelFamily: "qwen2.5" }, { modelFamily: "llama3.1" }]),
    ).not.toThrow();
  });

  it("throws InsufficientJudgesError with fewer than 2 judges", () => {
    expect(() => assertDistinctModelFamilies([{ modelFamily: "qwen2.5" }])).toThrow(
      InsufficientJudgesError,
    );
    expect(() => assertDistinctModelFamilies([])).toThrow(InsufficientJudgesError);
  });

  it("throws DuplicateModelFamilyError when two judges share a modelFamily — the coincidental-diversity failure mode ADR 0003 exists to catch", () => {
    const sameModelTwice = [new ScriptedGraderProvider([[]]), new ScriptedGraderProvider([[]])];
    expect(() => assertDistinctModelFamilies(sameModelTwice)).toThrow(DuplicateModelFamilyError);
  });
});

describe("assertEscalationDispatchAllowed", () => {
  it("allows a synthetic-only pack regardless of allowHostedEscalation", () => {
    expect(() => assertEscalationDispatchAllowed({ dataPolicy: "synthetic-only" })).not.toThrow();
  });

  it("throws for a restricted pack that hasn't set allowHostedEscalation: true", () => {
    expect(() => assertEscalationDispatchAllowed({ dataPolicy: "restricted" })).toThrow();
    expect(() =>
      assertEscalationDispatchAllowed({ dataPolicy: "restricted", allowHostedEscalation: false }),
    ).toThrow();
  });

  it("allows a restricted pack that has explicitly set allowHostedEscalation: true", () => {
    expect(() =>
      assertEscalationDispatchAllowed({ dataPolicy: "restricted", allowHostedEscalation: true }),
    ).not.toThrow();
  });
});
