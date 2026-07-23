import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("reconcileRunFindings", () => {
  let db: DroverDb;

  beforeEach(() => {
    db = new DroverDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function makeRunWithSessionAndFindings(matchKeys: string[]): {
    run: Run;
    session: PersonaSession;
  } {
    const run: Run = { id: newId(), appName, config, status: "running", startedAt: Date.now() };
    db.insertRun(run);
    const session: PersonaSession = {
      id: newId(),
      runId: run.id,
      personaId: "p1",
      goalId: "g1",
      status: "running",
      startedAt: Date.now(),
    };
    db.insertSession(session);

    for (const matchKey of matchKeys) {
      const eventId = db.insertActionEvent({
        sessionId: session.id,
        timestamp: Date.now(),
        actionType: "console-error",
        target: "/broken",
        reasoning: "fixture",
      });
      const finding: InSessionFinding = {
        id: newId(),
        sessionId: session.id,
        eventId,
        type: "console-error",
        severity: "low",
        description: "fixture finding",
        matchKey,
        createdAt: Date.now(),
      };
      db.insertInSessionFinding(finding);
    }
    return { run, session };
  }

  it("tags a match_key never seen before (for this app) as new", () => {
    const { run } = makeRunWithSessionAndFindings(["console-error:/broken"]);
    const summary = reconcileRunFindings(db, run.id, appName);
    expect(summary).toEqual({ new: 1, stillOpen: 0, resolved: 0 });
    expect(db.getStatusHistory("console-error:/broken")).toMatchObject([
      { runId: run.id, status: "new" },
    ]);
  });

  it("tags a match_key seen in a prior run as still-open, and marks it resolved once absent", () => {
    const matchKey = "console-error:/broken";

    const run1 = makeRunWithSessionAndFindings([matchKey]);
    reconcileRunFindings(db, run1.run.id, appName);

    const run2 = makeRunWithSessionAndFindings([matchKey]);
    const summary2 = reconcileRunFindings(db, run2.run.id, appName);
    expect(summary2).toEqual({ new: 0, stillOpen: 1, resolved: 0 });

    // run3: the finding no longer occurs.
    const run3 = makeRunWithSessionAndFindings([]);
    const summary3 = reconcileRunFindings(db, run3.run.id, appName);
    expect(summary3).toEqual({ new: 0, stillOpen: 0, resolved: 1 });

    const history = db.getStatusHistory(matchKey);
    expect(history.map((h) => h.status)).toEqual(["new", "still-open", "resolved"]);
  });

  it("does not re-flag an already-resolved match_key on subsequent absent runs", () => {
    const matchKey = "console-error:/broken";
    const run1 = makeRunWithSessionAndFindings([matchKey]);
    reconcileRunFindings(db, run1.run.id, appName);
    const run2 = makeRunWithSessionAndFindings([]);
    expect(reconcileRunFindings(db, run2.run.id, appName)).toEqual({
      new: 0,
      stillOpen: 0,
      resolved: 1,
    });
    const run3 = makeRunWithSessionAndFindings([]);
    expect(reconcileRunFindings(db, run3.run.id, appName)).toEqual({
      new: 0,
      stillOpen: 0,
      resolved: 0,
    });
  });

  it("scopes matching to the same appName", () => {
    const matchKey = "console-error:/broken";
    const run1 = makeRunWithSessionAndFindings([matchKey]);
    reconcileRunFindings(db, run1.run.id, appName);

    // A run for a different app with the same match_key should be "new", not "still-open".
    const otherRun: Run = {
      id: newId(),
      appName: "other-app",
      config,
      status: "running",
      startedAt: Date.now(),
    };
    db.insertRun(otherRun);
    const otherSession: PersonaSession = {
      id: newId(),
      runId: otherRun.id,
      personaId: "p1",
      goalId: "g1",
      status: "running",
      startedAt: Date.now(),
    };
    db.insertSession(otherSession);
    const eventId = db.insertActionEvent({
      sessionId: otherSession.id,
      timestamp: Date.now(),
      actionType: "console-error",
      target: "/broken",
      reasoning: "fixture",
    });
    db.insertInSessionFinding({
      id: newId(),
      sessionId: otherSession.id,
      eventId,
      type: "console-error",
      severity: "low",
      description: "fixture",
      matchKey,
      createdAt: Date.now(),
    });

    expect(reconcileRunFindings(db, otherRun.id, "other-app")).toEqual({
      new: 1,
      stillOpen: 0,
      resolved: 0,
    });
  });
});
