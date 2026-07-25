import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionDigest } from "../../src/analyst/digest.js";
import { DroverDb, newId } from "../../src/db/database.js";
import type { InSessionFinding, PersonaSession, Run, SimConfig } from "../../src/types/index.js";

const config: SimConfig = {
  targetBaseUrl: "http://127.0.0.1:0",
  runDimensions: { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
  budget: { runCeilingUsd: 10, perSessionSoftCapUsd: 1 },
  modelRouting: {
    actor: { provider: "scripted", model: "scripted" },
    analyst: { provider: "scripted", model: "scripted" },
  },
};

describe("buildSessionDigest", () => {
  let db: DroverDb;

  beforeEach(() => {
    db = new DroverDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function makeSession(overrides?: Partial<PersonaSession>): PersonaSession {
    const run: Run = {
      id: newId(),
      appName: "fixture-app",
      config,
      status: "completed",
      startedAt: 0,
    };
    db.insertRun(run);
    const session: PersonaSession = {
      id: newId(),
      runId: run.id,
      personaId: "p1",
      goalId: "g1",
      status: "completed",
      startedAt: 1000,
      endedAt: 5000,
      ...overrides,
    };
    db.insertSession(session);
    return session;
  }

  it("computes derived metrics from raw event timestamps", () => {
    const session = makeSession();
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1200,
      actionType: "navigate",
      target: "/a",
      reasoning: "start",
    });
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1500,
      actionType: "click",
      target: "#btn",
      reasoning: "click it",
    });
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: 3000,
      actionType: "click",
      target: "#next",
      reasoning: "and again, after a long pause",
    });

    const digest = buildSessionDigest(db, session);

    expect(digest.sessionId).toBe(session.id);
    expect(digest.personaId).toBe("p1");
    expect(digest.goalId).toBe("g1");
    expect(digest.status).toBe("completed");
    expect(digest.actionCount).toBe(3);
    expect(digest.timeToFirstActionMs).toBe(200); // 1200 - 1000
    expect(digest.totalDurationMs).toBe(4000); // 5000 - 1000 (session.endedAt wins over last event)
    expect(digest.longestGapMs).toBe(1500); // 3000 - 1500
    expect(digest.actionsSummary).toEqual([
      "[navigate] /a — start",
      "[click] #btn — click it",
      "[click] #next — and again, after a long pause",
    ]);
  });

  it("keeps the largest gap even when a later gap is smaller, rather than overwriting with the latest", () => {
    const session = makeSession();
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1100,
      actionType: "navigate",
      target: "/a",
      reasoning: "start",
    });
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: 2000,
      actionType: "click",
      target: "#btn",
      reasoning: "after a long pause",
    });
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: 2100,
      actionType: "click",
      target: "#next",
      reasoning: "quickly after that",
    });

    const digest = buildSessionDigest(db, session);

    // Gaps are 900 (1100 -> 2000) then 100 (2000 -> 2100) — the smaller,
    // later gap must not overwrite the larger, earlier one.
    expect(digest.longestGapMs).toBe(900);
  });

  it("falls back to the last event's timestamp when the session has no endedAt", () => {
    const session = makeSession({ status: "running", endedAt: undefined });
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1300,
      actionType: "navigate",
      target: "/a",
      reasoning: "start",
    });

    const digest = buildSessionDigest(db, session);
    expect(digest.totalDurationMs).toBe(300); // 1300 - 1000
  });

  it("omits derived metrics entirely when a session has no events and no endedAt", () => {
    const session = makeSession({ status: "running", endedAt: undefined });
    const digest = buildSessionDigest(db, session);

    expect(digest.actionCount).toBe(0);
    expect(digest.timeToFirstActionMs).toBeUndefined();
    expect(digest.totalDurationMs).toBeUndefined();
    expect(digest.longestGapMs).toBeUndefined();
    expect(digest.actionsSummary).toEqual([]);
  });

  it("computes per-checkpoint reach times from checkpoint-tagged events, keeping the first reach", () => {
    const session = makeSession();
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1200,
      actionType: "navigate",
      target: "/a",
      reasoning: "start",
    });
    const taggedEventId = db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1800,
      actionType: "click",
      target: "#submit",
      reasoning: "submit the form",
    });
    db.updateActionEventCheckpoint(taggedEventId, "cp-signup-complete");
    const secondTagId = db.insertActionEvent({
      sessionId: session.id,
      timestamp: 3400,
      actionType: "click",
      target: "#next",
      reasoning: "keep going",
    });
    db.updateActionEventCheckpoint(secondTagId, "cp-signup-complete");

    const digest = buildSessionDigest(db, session);

    expect(digest.checkpointReachTimesMs).toEqual({ "cp-signup-complete": 800 }); // 1800 - 1000, first reach wins
  });

  it("has an empty checkpointReachTimesMs when no event was tagged with a checkpoint", () => {
    const session = makeSession();
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1200,
      actionType: "navigate",
      target: "/a",
      reasoning: "start",
    });

    const digest = buildSessionDigest(db, session);
    expect(digest.checkpointReachTimesMs).toEqual({});
  });

  it("includes in-session findings as summary lines", () => {
    const session = makeSession();
    const eventId = db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1200,
      actionType: "console-error",
      target: "TypeError: boom",
      reasoning: "console error observed",
    });
    const finding: InSessionFinding = {
      id: newId(),
      sessionId: session.id,
      eventId,
      type: "console-error",
      severity: "low",
      description: "A console error fired.",
      matchKey: "console-error:TypeError: boom",
      createdAt: 1200,
    };
    db.insertInSessionFinding(finding);

    const digest = buildSessionDigest(db, session);
    expect(digest.findingsSummary).toEqual(["console-error (low): A console error fired."]);
  });

  it("truncates very long action traces", () => {
    const session = makeSession();
    for (let i = 0; i < 45; i++) {
      db.insertActionEvent({
        sessionId: session.id,
        timestamp: 1000 + i,
        actionType: "click",
        target: `#btn-${i}`,
        reasoning: "clicking around",
      });
    }

    const digest = buildSessionDigest(db, session);
    expect(digest.actionCount).toBe(45);
    expect(digest.actionsSummary).toHaveLength(41); // 40 shown + one omission line
    expect(digest.actionsSummary.at(-1)).toMatch(/5 more action\(s\) omitted/);
  });
});
