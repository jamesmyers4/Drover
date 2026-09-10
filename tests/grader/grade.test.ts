/**
 * `runGrading`/`buildLayerRegistry` (Grader Session 6) — the entry point
 * tying the scheduler and all seven layers into one coherent Grading Run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraderDb } from "../../src/grader/db.js";
import { buildLayerRegistry, runGrading } from "../../src/grader/grade.js";
import type { GraderPack, Rubric } from "../../src/grader/types.js";

const toneRubric: Rubric = {
  key: "tone-eval",
  description: "Scores tone and overall quality.",
  checks: [
    { name: "on-brand-tone", description: "Reads as warm, not clinical.", scoringType: "boolean" },
  ],
};

function makePack(): GraderPack {
  return {
    appName: "toy-app",
    rubrics: { "tone-eval": toneRubric },
    loadCases: () => [{ input: { prompt: "hi" }, output: { text: "hello!" }, rubric: "tone-eval" }],
    dataPolicy: "synthetic-only",
  };
}

describe("buildLayerRegistry", () => {
  it("always registers Layers 1-3, using the singleJudge route for both 2 and 3", () => {
    const { registry, consensusLayersEnabled } = buildLayerRegistry(makePack(), {
      singleJudge: { provider: "ollama", model: "test-model" },
      consensusJudges: [],
    });

    expect(Object.keys(registry).map(Number).sort()).toEqual([1, 2, 3]);
    expect(consensusLayersEnabled).toEqual([]);
  });

  it("registers Layers 4-7 when >= 2 distinct-family judges and an escalation route are configured", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registry, consensusLayersEnabled } = buildLayerRegistry(makePack(), {
      singleJudge: { provider: "ollama", model: "test-model" },
      consensusJudges: [
        { provider: "ollama", model: "model-a" },
        { provider: "ollama", model: "model-b" },
      ],
      escalation: { provider: "ollama", model: "model-a" },
    });

    expect(Object.keys(registry).map(Number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(consensusLayersEnabled).toEqual([4, 5, 6, 7]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips Layers 4-7 with a console warning when fewer than 2 consensus judges are configured", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registry, consensusLayersEnabled } = buildLayerRegistry(makePack(), {
      singleJudge: { provider: "ollama", model: "test-model" },
      consensusJudges: [{ provider: "ollama", model: "model-a" }],
      escalation: { provider: "ollama", model: "model-a" },
    });

    expect(Object.keys(registry).map(Number).sort()).toEqual([1, 2, 3]);
    expect(consensusLayersEnabled).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/Skipping Layers 4-7/);
    warnSpy.mockRestore();
  });

  it("skips Layers 4-7 when 2+ judges are configured but no escalation route is", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { consensusLayersEnabled } = buildLayerRegistry(makePack(), {
      singleJudge: { provider: "ollama", model: "test-model" },
      consensusJudges: [
        { provider: "ollama", model: "model-a" },
        { provider: "ollama", model: "model-b" },
      ],
    });

    expect(consensusLayersEnabled).toEqual([]);
    warnSpy.mockRestore();
  });
});

describe("runGrading", () => {
  let db: GraderDb;

  beforeEach(() => {
    db = new GraderDb(":memory:");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("dispatches a real Grading Run through the built registry and reports which consensus layers ran", async () => {
    const pack = makePack();
    const result = await runGrading({
      db,
      pack,
      routing: {
        // A real ModelRoute shape (only "ollama"/"anthropic" construct without
        // throwing) pointed at a model name that doesn't exist — Layer 2/3's
        // dispatch may well fail against it (no reachable/matching Ollama
        // model in every test environment), but Session 3's Task-level error
        // isolation means that still completes the run rather than crashing
        // it, which is the thing this test actually exercises: `runGrading`'s
        // own wiring end to end, not real judge behavior.
        singleJudge: { provider: "ollama", model: "nonexistent-test-model" },
        consensusJudges: [],
      },
    });

    // No consensus judges configured — Layers 4-7 are skipped, exercised end
    // to end via the real `runGrading` entry point, not just
    // `buildLayerRegistry` in isolation.
    expect(result.consensusLayersEnabled).toEqual([]);
    expect(result.status).toBe("completed");
    expect(result.gradingRunId).toBeTruthy();
    expect(result.casesProcessed).toBe(1);
  });
});
