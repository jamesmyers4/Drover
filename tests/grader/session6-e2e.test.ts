/**
 * End-to-end confirmation for Grader Session 6's stop condition: a full
 * Grading Run across Layers 1-7 against a small toy pack, dispatched
 * through the real scheduler (`runGradingRun`) and rendered into a real
 * Grading report — mirroring Session 4's `session4-e2e.test.ts` precedent,
 * extended to cover the multi-judge Consensus Round layers this session
 * adds. No local Ollama diversity is available to validate against for
 * real yet (GAPS.md's 2026-09-09 entry) — every judge here is a
 * `ScriptedGraderProvider`, same "prove the mechanics, flag the real-infra
 * gap" precedent Sessions 4-5 already established.
 *
 * Deliberately exercises both outcomes a real reference pack (Session 8)
 * will need: a Case where every judge agrees end to end (no escalation),
 * and a Case where two judges genuinely disagree on Layer 4, triggering a
 * real escalation Task — satisfying the "at least one Consensus-Round-
 * triggering pair" bar named for Session 8, proven here first at the
 * engine level.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraderDb } from "../../src/grader/db.js";
import { layer1 } from "../../src/grader/layers/layer1.js";
import { createLayer2 } from "../../src/grader/layers/layer2.js";
import { createLayer3 } from "../../src/grader/layers/layer3.js";
import { createLayer4 } from "../../src/grader/layers/layer4.js";
import { createLayer5 } from "../../src/grader/layers/layer5.js";
import { createLayer6 } from "../../src/grader/layers/layer6.js";
import { createLayer7 } from "../../src/grader/layers/layer7.js";
import { ScriptedGraderProvider } from "../../src/grader/provider.js";
import { buildGradingReport } from "../../src/grader/report.js";
import { renderGradingReportMarkdown } from "../../src/grader/report-markdown.js";
import { runGradingRun } from "../../src/grader/scheduler.js";
import type { GraderPack, Rubric } from "../../src/grader/types.js";

class FamilyScriptedProvider extends ScriptedGraderProvider {
  override readonly modelFamily: string;
  constructor(family: string, script: ConstructorParameters<typeof ScriptedGraderProvider>[0]) {
    super(script);
    this.modelFamily = family;
  }
}

const toneRubric: Rubric = {
  key: "tone-eval",
  description: "Checks whether a volunteer-facing message reads as warm and on-brand.",
  checks: [
    { name: "on-brand-tone", description: "Reads as warm, not clinical.", scoringType: "boolean" },
  ],
};

function vote(value: boolean, reasoning: string) {
  return [{ name: "on-brand-tone", value, reasoning }];
}

describe("Grader Session 6 end-to-end: Layers 1-7 via the real scheduler, SQLite, and Grading report", () => {
  let db: GraderDb;

  beforeEach(() => {
    db = new GraderDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("dispatches Layers 1-7 for two Cases — one clean agreement, one genuine escalation — and renders a real Grading report", async () => {
    const singleJudge = new ScriptedGraderProvider([
      vote(true, "Warm greeting."), // case 1, layer 2
      vote(true, "Warm greeting."), // case 1, layer 3
      vote(false, "Reads dismissive."), // case 2, layer 2
      vote(false, "Reads dismissive."), // case 2, layer 3
    ]);
    const judgeA = new FamilyScriptedProvider("family-a", [
      vote(true, "Warm."), // case1 L4
      vote(true, "Warm."), // case1 L5
      vote(true, "Warm."), // case1 L6
      vote(true, "Warm."), // case1 L7
      vote(true, "Reads fine to me."), // case2 L4 (disagrees with judgeB)
      vote(false, "Dismissive."), // case2 L5
      vote(false, "Dismissive."), // case2 L6
      vote(false, "Dismissive."), // case2 L7
    ]);
    const judgeB = new FamilyScriptedProvider("family-b", [
      vote(true, "Warm."),
      vote(true, "Warm."),
      vote(true, "Warm."),
      vote(true, "Warm."),
      vote(false, "This reads as dismissive, not warm."), // case2 L4 (disagrees with judgeA)
      vote(false, "Dismissive."),
      vote(false, "Dismissive."),
      vote(false, "Dismissive."),
    ]);
    const escalation = new FamilyScriptedProvider("family-escalation", [
      vote(false, "Tie-break: agrees with the judge who read it as dismissive."), // case2 L4
    ]);

    const pack: GraderPack = {
      appName: "toy-app",
      rubrics: { "tone-eval": toneRubric },
      loadCases: () => [
        {
          input: { context: "new volunteer signs up" },
          output: { text: "Welcome aboard — thanks so much for volunteering!" },
          rubric: "tone-eval",
        },
        {
          input: { context: "volunteer asks to reschedule" },
          output: { text: "Not our problem, figure it out." },
          rubric: "tone-eval",
        },
      ],
      dataPolicy: "synthetic-only",
    };

    const result = await runGradingRun({
      db,
      pack,
      layers: {
        1: layer1,
        2: createLayer2(singleJudge),
        3: createLayer3(singleJudge),
        4: createLayer4([judgeA, judgeB], escalation),
        5: createLayer5([judgeA, judgeB], escalation),
        6: createLayer6([judgeA, judgeB], escalation),
        7: createLayer7([judgeA, judgeB], escalation),
      },
    });

    expect(result.status).toBe("completed");
    expect(result.casesProcessed).toBe(2);
    // 7 layers x 2 cases = 14 rollup Tasks total.
    expect(result.tasksPassed + result.tasksFailed + result.tasksSkipped).toBe(14);

    const report = buildGradingReport(db, result.gradingRunId);
    expect(report.casesProcessed).toBe(2);
    expect(report.totalEscalations).toBe(1);

    // Triage sort: the Case with an escalation sorts first, ahead of the
    // clean-agreement Case, regardless of insertion order.
    const [first, second] = report.cases;
    expect(first?.escalationCount).toBe(1);
    expect(second?.escalationCount).toBe(0);
    expect(first?.output).toEqual({ text: "Not our problem, figure it out." });
    expect(first?.layers[4]?.status).toBe("fail");
    expect(first?.layers[4]?.checks[0]?.reasoning).toMatch(/disagreed/);
    expect(second?.layers[1]?.status).toBe("pass");
    expect(second?.layers[4]?.status).toBe("pass");

    // The real Consensus Round + its escalation Task both persisted.
    const rounds = db.getConsensusRoundsByCase(first?.caseId ?? "");
    const layer4Round = rounds.find((r) => r.layerId === 4);
    expect(layer4Round?.status).toBe("resolved");
    expect(layer4Round?.checkResolutions).toEqual([
      { name: "on-brand-tone", outcome: "escalated", finalValue: false },
    ]);

    const markdown = renderGradingReportMarkdown(report);
    expect(markdown).toContain("# Grading Report — toy-app");
    expect(markdown).toContain("escalation Task adjudicated");
    expect(markdown).toContain("tone-eval");
  });
});
