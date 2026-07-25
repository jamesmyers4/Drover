import { describe, expect, it } from "vitest";
import { percentile, type ReplaySample, summarizeSamples } from "../../src/stampede/metrics.js";

describe("percentile", () => {
  it("throws on an empty array", () => {
    expect(() => percentile([], 50)).toThrow();
  });

  it("returns the only value for a single-sample array at any percentile", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("computes nearest-rank percentiles over a sorted array", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 100)).toBe(100);
  });
});

describe("summarizeSamples", () => {
  function sample(route: string, concurrency: number, durationMs: number, ok = true): ReplaySample {
    return { route, concurrency, durationMs, ok };
  }

  it("groups by (route, concurrency) and computes sample count, error count, and percentiles per group", () => {
    const samples: ReplaySample[] = [
      sample("/", 1, 10),
      sample("/", 1, 20),
      sample("/", 1, 30, false),
      sample("/horses", 1, 100),
      sample("/", 5, 200),
    ];

    const summaries = summarizeSamples(samples);
    expect(summaries).toHaveLength(3);

    const rootAt1 = summaries.find((s) => s.route === "/" && s.concurrency === 1);
    expect(rootAt1).toMatchObject({
      sampleCount: 3,
      errorCount: 1,
      p50Ms: 20,
      p95Ms: 30,
      p99Ms: 30,
    });

    const horsesAt1 = summaries.find((s) => s.route === "/horses" && s.concurrency === 1);
    expect(horsesAt1).toMatchObject({ sampleCount: 1, errorCount: 0 });

    const rootAt5 = summaries.find((s) => s.route === "/" && s.concurrency === 5);
    expect(rootAt5).toMatchObject({ sampleCount: 1, errorCount: 0, p50Ms: 200 });
  });

  it("sorts results by route then concurrency", () => {
    const samples: ReplaySample[] = [sample("/horses", 5, 1), sample("/", 5, 1), sample("/", 1, 1)];
    const summaries = summarizeSamples(samples);
    expect(summaries.map((s) => `${s.route}@${s.concurrency}`)).toEqual([
      "/@1",
      "/@5",
      "/horses@5",
    ]);
  });

  it("returns an empty array for no samples", () => {
    expect(summarizeSamples([])).toEqual([]);
  });
});
