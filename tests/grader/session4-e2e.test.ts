/**
 * End-to-end confirmation for Grader Session 4's stop condition: Layers 2-3
 * dispatch through the real scheduler (`runGradingRun`) against
 * `ScriptedGraderProvider` (no Ollama available in this build environment —
 * see this session's status note in FUTUREPLAN.md) and round-trip through
 * real SQLite, including the rubric snapshot.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraderDb } from "../../src/grader/db.js";
import { layer1 } from "../../src/grader/layers/layer1.js";
import { createLayer2 } from "../../src/grader/layers/layer2.js";
import { createLayer3 } from "../../src/grader/layers/layer3.js";
import { ScriptedGraderProvider } from "../../src/grader/provider.js";
import { snapshotRubric } from "../../src/grader/rubric.js";
import { runGradingRun } from "../../src/grader/scheduler.js";
import type { GraderPack, Rubric } from "../../src/grader/types.js";

const toneRubric: Rubric = {
  key: "tone-eval",
  description: "Scores tone and overall quality.",
  checks: [
    { name: "on-brand-tone", description: "Reads as warm, not clinical.", scoringType: "boolean" },
    {
      name: "quality-score",
      description: "1-5 overall quality.",
      scoringType: "numeric",
      numericTolerance: 0.5,
      passThreshold: { comparison: "gte", value: 3 },
    },
  ],
};

describe("Grader Session 4 end-to-end: Layers 2-3 via the real scheduler + SQLite", () => {
  let db: GraderDb;

  beforeEach(() => {
    db = new GraderDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("dispatches layers 1-3 for a Case, persisting real Task rows with rubric snapshots and provider identity", async () => {
    // One score() call each for layer 2 and layer 3 (layer 1 is deterministic, no provider call).
    const provider = new ScriptedGraderProvider(
      [
        [
          { name: "on-brand-tone", value: true, reasoning: "Warm, on-brand greeting." },
          { name: "quality-score", value: 4, reasoning: "Solid overall." },
        ],
        [
          { name: "on-brand-tone", value: true, reasoning: "Consistent with prior examples." },
          { name: "quality-score", value: 5, reasoning: "Matches golden expectations." },
        ],
      ],
      0.002,
    );

    const pack: GraderPack = {
      appName: "toy-app",
      rubrics: { "tone-eval": toneRubric },
      loadCases: () => [
        { input: { prompt: "hi" }, output: { text: "hello!" }, rubric: "tone-eval" },
      ],
      dataPolicy: "synthetic-only",
    };

    const result = await runGradingRun({
      db,
      pack,
      layers: { 1: layer1, 2: createLayer2(provider), 3: createLayer3(provider) },
    });

    expect(result.status).toBe("completed");
    expect(result.casesProcessed).toBe(1);
    expect(result.tasksPassed).toBe(3);
    expect(result.tasksFailed).toBe(0);
    expect(result.tasksSkipped).toBe(0);

    const [gradingCase] = db.getCasesByGradingRun(result.gradingRunId);
    if (!gradingCase) throw new Error("expected exactly one persisted Case");
    const tasks = db.getTasksByCase(gradingCase.id).sort((a, b) => a.layerId - b.layerId);
    expect(tasks.map((t) => t.layerId)).toEqual([1, 2, 3]);

    const [layer1Task, layer2Task, layer3Task] = tasks;
    expect(layer1Task?.rubricSnapshot).toBeUndefined();
    expect(layer1Task?.modelFamily).toBeUndefined();

    const expectedSnapshot = snapshotRubric(toneRubric);
    for (const task of [layer2Task, layer3Task]) {
      expect(task?.status).toBe("pass");
      expect(task?.modelFamily).toBe("scripted");
      expect(task?.executionTarget).toBe("scripted");
      expect(task?.rubricSnapshot?.contentHash).toBe(expectedSnapshot.contentHash);
      expect(task?.rubricSnapshot?.content).toEqual(toneRubric);
      expect(task?.checks).toEqual([
        expect.objectContaining({ name: "on-brand-tone", value: true }),
        expect.objectContaining({ name: "quality-score" }),
      ]);
    }
  });

  it("persists a numeric-Check-only failure as a real 'fail' Task row — the exact case the pre-fix schema left unrepresentable", async () => {
    // Both judges (were there two) would agree perfectly on "1/5" here; the
    // boolean Check still passes. Before the passThreshold fix, this Task
    // would have persisted as status "pass" — nothing in the schema could
    // record a low-but-agreed-upon score as a failure.
    const provider = new ScriptedGraderProvider([
      [
        { name: "on-brand-tone", value: true, reasoning: "Tone itself is fine." },
        { name: "quality-score", value: 1, reasoning: "Substance is weak across the board." },
      ],
    ]);

    const pack: GraderPack = {
      appName: "toy-app",
      rubrics: { "tone-eval": toneRubric },
      loadCases: () => [
        { input: { prompt: "hi" }, output: { text: "hello!" }, rubric: "tone-eval" },
      ],
      dataPolicy: "synthetic-only",
    };

    const result = await runGradingRun({ db, pack, layers: { 3: createLayer3(provider) } });

    expect(result.tasksFailed).toBe(1);
    expect(result.tasksPassed).toBe(0);

    const [gradingCase] = db.getCasesByGradingRun(result.gradingRunId);
    if (!gradingCase) throw new Error("expected exactly one persisted Case");
    const [task] = db.getTasksByCase(gradingCase.id);
    expect(task?.status).toBe("fail");
    expect(task?.checks.find((c) => c.name === "quality-score")?.value).toBe(1);
  });

  it("a layer-2/3 Task failing (boolean Check false) cascades a skip to a declared dependent, same as layer1's own cascade behavior", async () => {
    const provider = new ScriptedGraderProvider([
      [
        { name: "on-brand-tone", value: false, reasoning: "Reads clinical, not warm." },
        { name: "quality-score", value: 3, reasoning: "Middling." },
      ],
    ]);

    const pack: GraderPack = {
      appName: "toy-app",
      rubrics: { "tone-eval": toneRubric },
      loadCases: () => [
        { input: { prompt: "hi" }, output: { text: "hello!" }, rubric: "tone-eval" },
      ],
      dataPolicy: "synthetic-only",
      layers: {
        1: {
          requires: [
            { layerId: 3, justification: "Structurally meaningless without a scored tone check." },
          ],
        },
      },
    };

    const result = await runGradingRun({
      db,
      pack,
      layers: { 1: layer1, 3: createLayer3(provider) },
    });

    expect(result.tasksFailed).toBe(1);
    expect(result.tasksSkipped).toBe(1);

    const [gradingCase] = db.getCasesByGradingRun(result.gradingRunId);
    if (!gradingCase) throw new Error("expected exactly one persisted Case");
    const tasks = db.getTasksByCase(gradingCase.id);
    const layer1Task = tasks.find((t) => t.layerId === 1);
    const layer3Task = tasks.find((t) => t.layerId === 3);
    expect(layer3Task?.status).toBe("fail");
    expect(layer1Task?.status).toBe("skipped");
  });
});
