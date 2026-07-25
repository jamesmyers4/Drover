import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DroverDb, newId } from "../src/db/database.js";
import type {
  ActionEvent,
  CrossSessionFinding,
  InSessionFinding,
  PersonaSession,
  Run,
  SimConfig,
} from "../src/types/index.js";

const sampleConfig: SimConfig = {
  targetBaseUrl: "https://staging.example.test",
  runDimensions: { orgSize: 5, simulatedWeeks: 2, sessionsPerPersonaPerWeek: 3 },
  budget: { runCeilingUsd: 10, perSessionSoftCapUsd: 0.5 },
  modelRouting: {
    actor: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    analyst: { provider: "anthropic", model: "claude-sonnet-5" },
  },
  concurrencyCap: 1,
};

function makeRun(): Run {
  return {
    id: newId(),
    appName: "horse-haven-ops",
    config: sampleConfig,
    status: "running",
    startedAt: Date.now(),
  };
}

function makeSession(runId: string): PersonaSession {
  return {
    id: newId(),
    runId,
    personaId: "impatient-rushed",
    goalId: "volunteer-check-in",
    status: "running",
    startedAt: Date.now(),
  };
}

describe("DroverDb", () => {
  let db: DroverDb;

  beforeEach(() => {
    db = new DroverDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("migrates cleanly on an empty database", () => {
    // beforeEach already ran the migration; a second instance re-running it
    // against a fresh empty DB must also succeed.
    const fresh = new DroverDb(":memory:");
    fresh.close();
  });

  it("round-trips a run, including the config snapshot", () => {
    const run = makeRun();
    db.insertRun(run);
    expect(db.getRun(run.id)).toEqual(run);
  });

  it("round-trips a run's checkpointContext when present", () => {
    const run: Run = {
      ...makeRun(),
      checkpointContext: {
        "cp-signup-complete": {
          goalId: "signup-flow",
          description: "User submits the signup form",
        },
      },
    };
    db.insertRun(run);
    expect(db.getRun(run.id)).toEqual(run);
  });

  it("omits checkpointContext from a round-tripped run when it was never supplied", () => {
    const run = makeRun();
    db.insertRun(run);
    const fetched = db.getRun(run.id);
    expect(fetched).not.toHaveProperty("checkpointContext");
  });

  it("updates run status and end time", () => {
    const run = makeRun();
    db.insertRun(run);
    const endedAt = run.startedAt + 1000;
    db.updateRunStatus(run.id, "budget-stopped", endedAt);
    expect(db.getRun(run.id)).toEqual({ ...run, status: "budget-stopped", endedAt });
  });

  it("omits actorCostUsd/analystCostUsd from a round-tripped run when never set", () => {
    const run = makeRun();
    db.insertRun(run);
    const fetched = db.getRun(run.id);
    expect(fetched).not.toHaveProperty("actorCostUsd");
    expect(fetched).not.toHaveProperty("analystCostUsd");
  });

  it("updateRunActorCost overwrites the recorded actor spend", () => {
    const run = makeRun();
    db.insertRun(run);
    db.updateRunActorCost(run.id, 1.25);
    expect(db.getRun(run.id)?.actorCostUsd).toBe(1.25);
    db.updateRunActorCost(run.id, 2.5);
    expect(db.getRun(run.id)?.actorCostUsd).toBe(2.5);
  });

  it("updateRunAnalystCost accumulates across multiple `drover analyze` passes", () => {
    const run = makeRun();
    db.insertRun(run);
    db.updateRunAnalystCost(run.id, 0.1);
    expect(db.getRun(run.id)?.analystCostUsd).toBeCloseTo(0.1);
    db.updateRunAnalystCost(run.id, 0.2);
    expect(db.getRun(run.id)?.analystCostUsd).toBeCloseTo(0.3);
  });

  it("round-trips a session", () => {
    const run = makeRun();
    db.insertRun(run);
    const session = makeSession(run.id);
    db.insertSession(session);
    expect(db.getSession(session.id)).toEqual(session);

    db.updateSessionStatus(session.id, "hard-stopped", session.startedAt + 500);
    expect(db.getSession(session.id)?.status).toBe("hard-stopped");
    expect(db.getSessionsByRun(run.id)).toHaveLength(1);
  });

  it("round-trips action events in timestamp order", () => {
    const run = makeRun();
    db.insertRun(run);
    const session = makeSession(run.id);
    db.insertSession(session);

    const first: ActionEvent = {
      sessionId: session.id,
      timestamp: 1000,
      actionType: "navigate",
      target: "/horses",
      reasoning: "Starting at the horse list to find the check-in page.",
    };
    const second: ActionEvent = {
      sessionId: session.id,
      timestamp: 2000,
      actionType: "click",
      target: "button#check-in",
      reasoning: "This looks like the check-in button.",
      checkpointId: "reached-check-in",
    };
    // Insert out of order to prove ordering comes from timestamps.
    db.insertActionEvent(second);
    const firstId = db.insertActionEvent(first);

    const events = db.getEventsBySession(session.id);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ ...first, id: firstId });
    expect(events[1]).toMatchObject(second);
  });

  it("tags an already-inserted action event with a checkpoint via updateActionEventCheckpoint", () => {
    const run = makeRun();
    db.insertRun(run);
    const session = makeSession(run.id);
    db.insertSession(session);

    const eventId = db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1000,
      actionType: "navigate",
      target: "/dashboard",
      reasoning: "Heading to the dashboard.",
    });
    expect(db.getEventsBySession(session.id)[0]?.checkpointId).toBeUndefined();

    db.updateActionEventCheckpoint(eventId, "on-dashboard");
    expect(db.getEventsBySession(session.id)[0]?.checkpointId).toBe("on-dashboard");
  });

  it("round-trips an in-session finding referencing a single event", () => {
    const run = makeRun();
    db.insertRun(run);
    const session = makeSession(run.id);
    db.insertSession(session);
    const eventId = db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1000,
      actionType: "click",
      target: "button#save",
      reasoning: "Trying to save the schedule.",
    });

    const finding: InSessionFinding = {
      id: newId(),
      sessionId: session.id,
      eventId,
      type: "http-failure",
      severity: "high",
      description: "POST /api/schedule returned 500",
      matchKey: "http-failure:/api/schedule:POST",
      screenshotPath: "runs/abc/screenshots/f1.png",
      traceSnippet: "500 Internal Server Error",
      createdAt: Date.now(),
    };
    db.insertInSessionFinding(finding);
    expect(db.getInSessionFinding(finding.id)).toEqual(finding);
  });

  it("round-trips a cross-session finding referencing a set of sessions", () => {
    const run = makeRun();
    db.insertRun(run);
    const s1 = makeSession(run.id);
    const s2 = makeSession(run.id);
    db.insertSession(s1);
    db.insertSession(s2);

    const finding: CrossSessionFinding = {
      id: newId(),
      runId: run.id,
      type: "repeated-stumble-route",
      severity: "medium",
      description: "Multiple personas independently got stuck on /schedule/edit",
      sessionIds: [s1.id, s2.id],
      matchKey: "repeated-stumble-route:/schedule/edit",
      createdAt: Date.now(),
    };
    db.insertCrossSessionFinding(finding);
    expect(db.getCrossSessionFinding(finding.id)).toEqual(finding);
  });

  it("tracks finding status history so open-run count is a query", () => {
    const matchKey = "http-failure:/api/schedule:POST";
    const runs = [makeRun(), makeRun(), makeRun()];
    for (const run of runs) db.insertRun(run);

    db.recordFindingStatus({
      matchKey,
      runId: runs[0]?.id ?? "",
      findingKind: "in-session",
      findingId: newId(),
      status: "new",
      recordedAt: 1,
    });
    db.recordFindingStatus({
      matchKey,
      runId: runs[1]?.id ?? "",
      findingKind: "in-session",
      findingId: newId(),
      status: "still-open",
      recordedAt: 2,
    });
    db.recordFindingStatus({
      matchKey,
      runId: runs[2]?.id ?? "",
      findingKind: "in-session",
      findingId: newId(),
      status: "resolved",
      recordedAt: 3,
    });

    const history = db.getStatusHistory(matchKey);
    expect(history.map((h) => h.status)).toEqual(["new", "still-open", "resolved"]);
    expect(db.countOpenRuns(matchKey)).toBe(2);
    expect(db.countOpenRuns("no-such-key")).toBe(0);
  });

  it("recordFindingStatus upserts on (match_key, run_id) instead of erroring on a second write", () => {
    const matchKey = "console-error:/broken";
    const run = makeRun();
    db.insertRun(run);

    db.recordFindingStatus({
      matchKey,
      runId: run.id,
      findingKind: "in-session",
      findingId: newId(),
      status: "new",
      recordedAt: 1,
    });
    // A later reconciliation pass for the same run (e.g. the analyst tier
    // re-reconciling after cross-session findings land) overwrites the row
    // in place rather than throwing a primary-key violation.
    const crossSessionFindingId = newId();
    db.recordFindingStatus({
      matchKey,
      runId: run.id,
      findingKind: "cross-session",
      findingId: crossSessionFindingId,
      status: "still-open",
      recordedAt: 2,
    });

    const history = db.getStatusHistory(matchKey);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      matchKey,
      runId: run.id,
      findingKind: "cross-session",
      findingId: crossSessionFindingId,
      status: "still-open",
      recordedAt: 2,
    });
  });

  it("getStatusHistoryForRun returns only this run's status records, in recorded order", () => {
    const matchKey = "http-failure:/api/schedule:POST";
    const otherMatchKey = "console-error:/broken";
    const runA = makeRun();
    const runB = makeRun();
    db.insertRun(runA);
    db.insertRun(runB);

    db.recordFindingStatus({
      matchKey,
      runId: runA.id,
      findingKind: "in-session",
      findingId: newId(),
      status: "new",
      recordedAt: 1,
    });
    db.recordFindingStatus({
      matchKey: otherMatchKey,
      runId: runA.id,
      findingKind: "in-session",
      findingId: newId(),
      status: "still-open",
      recordedAt: 2,
    });
    db.recordFindingStatus({
      matchKey,
      runId: runB.id,
      findingKind: "in-session",
      findingId: newId(),
      status: "new",
      recordedAt: 1,
    });

    const history = db.getStatusHistoryForRun(runA.id);
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.runId === runA.id)).toBe(true);
    expect(history.map((h) => h.matchKey)).toEqual([matchKey, otherMatchKey]);
    expect(db.getStatusHistoryForRun("no-such-run")).toEqual([]);
  });

  it("enforces foreign keys and status check constraints", () => {
    expect(() => db.insertSession(makeSession("nonexistent-run"))).toThrowError(/FOREIGN KEY/);

    const run = makeRun();
    db.insertRun(run);
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid status
      db.insertRun({ ...makeRun(), status: "bogus" as any }),
    ).toThrowError(/CHECK/);
  });

  it("rejects an invalid sessions.status value", () => {
    const run = makeRun();
    db.insertRun(run);
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid status
      db.insertSession({ ...makeSession(run.id), status: "bogus" as any }),
    ).toThrowError(/CHECK/);
  });

  it("rejects invalid in_session_findings.type and .severity values", () => {
    const run = makeRun();
    db.insertRun(run);
    const session = makeSession(run.id);
    db.insertSession(session);
    const eventId = db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1000,
      actionType: "click",
      target: "button#save",
      reasoning: "Trying to save the schedule.",
    });
    const baseFinding: InSessionFinding = {
      id: newId(),
      sessionId: session.id,
      eventId,
      type: "http-failure",
      severity: "high",
      description: "POST /api/schedule returned 500",
      matchKey: "http-failure:/api/schedule:POST",
      createdAt: Date.now(),
    };

    expect(() =>
      db.insertInSessionFinding({
        ...baseFinding,
        id: newId(),
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid type
        type: "not-a-real-type" as any,
      }),
    ).toThrowError(/CHECK/);
    expect(() =>
      db.insertInSessionFinding({
        ...baseFinding,
        id: newId(),
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid severity
        severity: "catastrophic" as any,
      }),
    ).toThrowError(/CHECK/);
  });

  it("rejects invalid cross_session_findings.type and .severity values", () => {
    const run = makeRun();
    db.insertRun(run);
    const session = makeSession(run.id);
    db.insertSession(session);
    const baseFinding: CrossSessionFinding = {
      id: newId(),
      runId: run.id,
      type: "repeated-stumble-route",
      severity: "medium",
      description: "Multiple personas independently got stuck on /schedule/edit",
      sessionIds: [session.id],
      matchKey: "repeated-stumble-route:/schedule/edit",
      createdAt: Date.now(),
    };

    expect(() =>
      db.insertCrossSessionFinding({
        ...baseFinding,
        id: newId(),
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid type
        type: "not-a-real-type" as any,
      }),
    ).toThrowError(/CHECK/);
    expect(() =>
      db.insertCrossSessionFinding({
        ...baseFinding,
        id: newId(),
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid severity
        severity: "catastrophic" as any,
      }),
    ).toThrowError(/CHECK/);
  });

  it("rejects invalid finding_status_history.finding_kind and .status values", () => {
    const run = makeRun();
    db.insertRun(run);
    const baseRecord = {
      matchKey: "http-failure:/api/schedule:POST",
      runId: run.id,
      findingId: newId(),
      recordedAt: 1,
    };

    expect(() =>
      db.recordFindingStatus({
        ...baseRecord,
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid finding_kind
        findingKind: "not-a-real-kind" as any,
        status: "new",
      }),
    ).toThrowError(/CHECK/);
    expect(() =>
      db.recordFindingStatus({
        ...baseRecord,
        findingKind: "in-session",
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid status
        status: "bogus" as any,
      }),
    ).toThrowError(/CHECK/);
  });
});
