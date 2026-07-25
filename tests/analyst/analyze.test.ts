import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnalystBudgetExceededError,
  RunNotFoundError,
  runAnalyst,
} from "../../src/analyst/analyze.js";
import type { RawCrossSessionFinding } from "../../src/analyst/provider.js";
import { ScriptedAnalystProvider } from "../../src/analyst/provider.js";
import { DroverDb, newId } from "../../src/db/database.js";
import { reconcileRunFindings } from "../../src/orchestrator/reconcile.js";
import type { InSessionFinding, PersonaSession, Run, SimConfig } from "../../src/types/index.js";

const appName = "fixture-app";

const config: SimConfig = {
  targetBaseUrl: "http://127.0.0.1:0",
  runDimensions: { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
  budget: { runCeilingUsd: 10, perSessionSoftCapUsd: 1 },
  modelRouting: {
    actor: { provider: "scripted", model: "scripted" },
    analyst: { provider: "scripted", model: "scripted" },
  },
};

describe("runAnalyst", () => {
  let db: DroverDb;

  beforeEach(() => {
    db = new DroverDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function makeRunWithSessions(count: number): { run: Run; sessions: PersonaSession[] } {
    const run: Run = { id: newId(), appName, config, status: "completed", startedAt: 1000 };
    db.insertRun(run);
    const sessions: PersonaSession[] = [];
    for (let i = 0; i < count; i++) {
      const session: PersonaSession = {
        id: newId(),
        runId: run.id,
        personaId: `p${i}`,
        goalId: "g1",
        status: "completed",
        startedAt: 1000,
        endedAt: 2000,
      };
      db.insertSession(session);
      db.insertActionEvent({
        sessionId: session.id,
        timestamp: 1200,
        actionType: "navigate",
        target: "/schedule/edit",
        reasoning: "trying to edit the feeding schedule",
      });
      sessions.push(session);
    }
    return { run, sessions };
  }

  it("throws RunNotFoundError for an unknown run id", async () => {
    await expect(runAnalyst({ db, runId: "no-such-run" })).rejects.toThrow(RunNotFoundError);
  });

  it("returns an empty result for a run with no sessions, without calling the provider", async () => {
    const run: Run = { id: newId(), appName, config, status: "completed", startedAt: 1000 };
    db.insertRun(run);

    const provider = new ScriptedAnalystProvider([]);
    const analyzeSpy = vi.spyOn(provider, "analyze");

    const result = await runAnalyst({ db, runId: run.id, provider });
    expect(result).toEqual({
      runId: run.id,
      sessionsAnalyzed: 0,
      findingsWritten: 0,
      findingsSkipped: 0,
      skippedReasons: [],
      reconciliation: { new: 0, stillOpen: 0, resolved: 0 },
      costUsd: 0,
    });
    expect(analyzeSpy).not.toHaveBeenCalled();
  });

  it("passes the run's checkpointContext through to the analyst prompt", async () => {
    const run: Run = {
      id: newId(),
      appName,
      config,
      status: "completed",
      startedAt: 1000,
      checkpointContext: {
        "cp-signup-complete": { goalId: "g1", description: "User submits the signup form" },
      },
    };
    db.insertRun(run);
    const session: PersonaSession = {
      id: newId(),
      runId: run.id,
      personaId: "p0",
      goalId: "g1",
      status: "completed",
      startedAt: 1000,
      endedAt: 2000,
    };
    db.insertSession(session);
    const eventId = db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1200,
      actionType: "navigate",
      target: "/signup/complete",
      reasoning: "finishing signup",
    });
    db.updateActionEventCheckpoint(eventId, "cp-signup-complete");

    let capturedUserPrompt = "";
    const provider = {
      provider: "captured",
      model: "captured",
      analyze: async (req: { systemPrompt: string; userPrompt: string }) => {
        capturedUserPrompt = req.userPrompt;
        return {
          findings: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0,
          },
        };
      },
    };

    await runAnalyst({ db, runId: run.id, provider });

    expect(capturedUserPrompt).toContain(
      'cp-signup-complete ("User submits the signup form", goal: g1)',
    );
  });

  it("writes validated cross-session findings referencing the right sessions, and reconciles them", async () => {
    const { run, sessions } = makeRunWithSessions(2);
    const [s1, s2] = sessions;
    if (!s1 || !s2) throw new Error("unreachable");

    const raw: RawCrossSessionFinding[] = [
      {
        type: "repeated-stumble-route",
        severity: "high",
        description: "Two personas independently got stuck editing the feeding schedule.",
        sessionIds: [s1.id, s2.id],
        route: "/schedule/edit",
      },
    ];
    const provider = new ScriptedAnalystProvider(raw, 0.02);

    const result = await runAnalyst({ db, runId: run.id, provider });

    expect(result.sessionsAnalyzed).toBe(2);
    expect(result.findingsWritten).toBe(1);
    expect(result.findingsSkipped).toBe(0);
    expect(result.costUsd).toBe(0.02);
    expect(result.reconciliation).toEqual({ new: 1, stillOpen: 0, resolved: 0 });

    const findings = db.getCrossSessionFindingsByRun(run.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      runId: run.id,
      type: "repeated-stumble-route",
      severity: "high",
      sessionIds: [s1.id, s2.id],
      matchKey: "repeated-stumble-route:/schedule/edit",
    });

    expect(db.getStatusHistory("repeated-stumble-route:/schedule/edit")).toMatchObject([
      { runId: run.id, status: "new", findingKind: "cross-session" },
    ]);
  });

  it("skips malformed findings (invalid type, hallucinated session ids) without crashing", async () => {
    const { run, sessions } = makeRunWithSessions(1);
    const s1 = sessions[0];
    if (!s1) throw new Error("unreachable");

    const raw: RawCrossSessionFinding[] = [
      {
        type: "not-a-real-type",
        severity: "low",
        description: "x",
        sessionIds: [s1.id],
        route: "r",
      },
      {
        type: "duplicate-label",
        severity: "low",
        description: "x",
        sessionIds: ["ghost-session"],
        route: "r",
      },
      {
        type: "recurring-dead-end",
        severity: "medium",
        description: "A legitimate finding.",
        sessionIds: [s1.id],
        route: "/dead-end",
      },
    ];
    const provider = new ScriptedAnalystProvider(raw);

    const result = await runAnalyst({ db, runId: run.id, provider });

    expect(result.findingsWritten).toBe(1);
    expect(result.findingsSkipped).toBe(2);
    expect(result.skippedReasons).toHaveLength(2);
    expect(db.getCrossSessionFindingsByRun(run.id)).toHaveLength(1);
  });

  it("borrows a screenshot from a referenced session's in-session finding as representative evidence", async () => {
    const { run, sessions } = makeRunWithSessions(1);
    const s1 = sessions[0];
    if (!s1) throw new Error("unreachable");

    const eventId = db.insertActionEvent({
      sessionId: s1.id,
      timestamp: 1300,
      actionType: "console-error",
      target: "boom",
      reasoning: "console error",
    });
    const inSessionFinding: InSessionFinding = {
      id: newId(),
      sessionId: s1.id,
      eventId,
      type: "console-error",
      severity: "low",
      description: "A console error.",
      matchKey: "console-error:boom",
      screenshotPath: "runs/screenshots/evidence.png",
      traceSnippet: "[console-error] boom",
      createdAt: 1300,
    };
    db.insertInSessionFinding(inSessionFinding);

    const provider = new ScriptedAnalystProvider([
      {
        type: "recurring-dead-end",
        severity: "medium",
        description: "x",
        sessionIds: [s1.id],
        route: "/dead-end",
      },
    ]);

    await runAnalyst({ db, runId: run.id, provider });
    const [finding] = db.getCrossSessionFindingsByRun(run.id);
    expect(finding?.screenshotPath).toBe("runs/screenshots/evidence.png");
    expect(finding?.traceSnippet).toBe("[console-error] boom");
  });

  it("corrects a premature 'resolved' tag left by the orchestrator's pre-analyst reconciliation pass", async () => {
    // Simulates the real two-phase lifecycle: `drover run` reconciles right
    // after the run finishes (only in-session findings exist yet), then
    // `drover analyze` reconciles again once cross-session findings land.
    const matchKey = "repeated-stumble-route:/schedule/edit";

    // Run 1: the pattern was already known as a cross-session finding.
    const { run: run1, sessions: sessions1 } = makeRunWithSessions(2);
    const s1a = sessions1[0];
    if (!s1a) throw new Error("unreachable");
    await runAnalyst({
      db,
      runId: run1.id,
      provider: new ScriptedAnalystProvider([
        {
          type: "repeated-stumble-route",
          severity: "high",
          description: "x",
          sessionIds: [s1a.id],
          route: "/schedule/edit",
        },
      ]),
    });
    expect(db.getStatusHistory(matchKey).map((h) => h.status)).toEqual(["new"]);

    // Run 2: the orchestrator's own post-run reconciliation runs first, with
    // only in-session findings visible — the still-recurring cross-session
    // matchKey looks absent and would (incorrectly, in isolation) be tagged
    // "resolved".
    const { run: run2, sessions: sessions2 } = makeRunWithSessions(2);
    const s2a = sessions2[0];
    if (!s2a) throw new Error("unreachable");
    const orchestratorReconciliation = reconcileRunFindings(db, run2.id, appName);
    expect(orchestratorReconciliation.resolved).toBe(1);
    expect(db.getStatusHistory(matchKey).map((h) => h.status)).toEqual(["new", "resolved"]);

    // `drover analyze` then finds the same pattern again in run 2 and
    // reconciles a second time — the final state should be "still-open", not
    // stuck at the orchestrator's premature "resolved".
    const analystResult = await runAnalyst({
      db,
      runId: run2.id,
      provider: new ScriptedAnalystProvider([
        {
          type: "repeated-stumble-route",
          severity: "high",
          description: "x",
          sessionIds: [s2a.id],
          route: "/schedule/edit",
        },
      ]),
    });

    expect(analystResult.reconciliation).toEqual({ new: 0, stillOpen: 1, resolved: 0 });
    expect(db.getStatusHistory(matchKey).map((h) => h.status)).toEqual(["new", "still-open"]);
  });

  it("throws AnalystBudgetExceededError and never calls the provider when the pre-flight estimate exceeds analystCeilingUsd", async () => {
    const tightConfig: SimConfig = {
      ...config,
      modelRouting: {
        ...config.modelRouting,
        analyst: { provider: "anthropic", model: "claude-sonnet-5" },
      },
      budget: { ...config.budget, analystCeilingUsd: 0.0000001 },
    };
    const run: Run = {
      id: newId(),
      appName,
      config: tightConfig,
      status: "completed",
      startedAt: 1000,
    };
    db.insertRun(run);
    db.insertSession({
      id: newId(),
      runId: run.id,
      personaId: "p0",
      goalId: "g1",
      status: "completed",
      startedAt: 1000,
      endedAt: 2000,
    });

    const provider = new ScriptedAnalystProvider([]);
    const analyzeSpy = vi.spyOn(provider, "analyze");

    await expect(runAnalyst({ db, runId: run.id, provider })).rejects.toThrow(
      AnalystBudgetExceededError,
    );
    expect(analyzeSpy).not.toHaveBeenCalled();
  });

  it("proceeds normally when analystCeilingUsd is unset", async () => {
    const { run, sessions } = makeRunWithSessions(1);
    const s1 = sessions[0];
    if (!s1) throw new Error("unreachable");

    const provider = new ScriptedAnalystProvider([
      {
        type: "recurring-dead-end",
        severity: "medium",
        description: "x",
        sessionIds: [s1.id],
        route: "/dead-end",
      },
    ]);
    const analyzeSpy = vi.spyOn(provider, "analyze");

    await runAnalyst({ db, runId: run.id, provider });
    expect(analyzeSpy).toHaveBeenCalledTimes(1);
  });
});
