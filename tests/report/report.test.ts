import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DroverDb, newId } from "../../src/db/database.js";
import { reconcileRunFindings } from "../../src/orchestrator/reconcile.js";
import { buildRunReport, ReportRunNotFoundError } from "../../src/report/report.js";
import type {
  CrossSessionFinding,
  InSessionFinding,
  PersonaSession,
  Run,
  SimConfig,
} from "../../src/types/index.js";

const appName = "fixture-app";

const config: SimConfig = {
  targetBaseUrl: "http://127.0.0.1:0",
  runDimensions: { orgSize: 3, simulatedWeeks: 2, sessionsPerPersonaPerWeek: 1 },
  budget: { runCeilingUsd: 5, perSessionSoftCapUsd: 0.5, analystCeilingUsd: 1 },
  modelRouting: {
    actor: { provider: "scripted", model: "scripted" },
    analyst: { provider: "scripted", model: "scripted" },
  },
};

describe("buildRunReport", () => {
  let db: DroverDb;

  beforeEach(() => {
    db = new DroverDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function makeSession(runId: string, goalId: string): PersonaSession {
    const session: PersonaSession = {
      id: newId(),
      runId,
      personaId: "impatient-rushed",
      goalId,
      status: "completed",
      startedAt: 1000,
      endedAt: 2000,
    };
    db.insertSession(session);
    return session;
  }

  it("throws ReportRunNotFoundError for an unknown run id", () => {
    expect(() => buildRunReport(db, "no-such-run")).toThrow(ReportRunNotFoundError);
  });

  it("reports hasAnalystPass=false and no cost fields for a run with no cost recorded yet", () => {
    const run: Run = { id: newId(), appName, config, status: "completed", startedAt: 1000 };
    db.insertRun(run);
    makeSession(run.id, "check-in");

    const report = buildRunReport(db, run.id);
    expect(report.hasAnalystPass).toBe(false);
    expect(report.actorCostUsd).toBeUndefined();
    expect(report.analystCostUsd).toBeUndefined();
    expect(report.findings).toEqual([]);
    expect(report.findingsByFlow).toEqual({});
  });

  it("merges an in-session finding recurring across sessions into one row with a session count and status", () => {
    const run: Run = { id: newId(), appName, config, status: "completed", startedAt: 1000 };
    db.insertRun(run);
    db.updateRunActorCost(run.id, 0.42);

    const sessionA = makeSession(run.id, "check-in");
    const sessionB = makeSession(run.id, "check-in");

    const matchKey = "http-failure:/api/schedule:POST";
    for (const session of [sessionA, sessionB]) {
      const eventId = db.insertActionEvent({
        sessionId: session.id,
        timestamp: 1200,
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
        matchKey,
        screenshotPath: `shots/${session.id}.png`,
        createdAt: 1300,
      };
      db.insertInSessionFinding(finding);
    }
    reconcileRunFindings(db, run.id, appName, { crossSessionDataComplete: false });

    const report = buildRunReport(db, run.id);
    expect(report.actorCostUsd).toBe(0.42);
    expect(report.findings).toHaveLength(1);
    const row = report.findings[0];
    expect(row).toMatchObject({
      matchKey,
      type: "http-failure",
      severity: "high",
      status: "new",
    });
    expect(row?.sessionIds).toHaveLength(2);
    expect(row?.goalIds).toEqual(["check-in"]);
    expect(row?.evidence.eventIds).toHaveLength(2);
    expect(row?.evidence.screenshotPath).toBeDefined();
    expect(report.findingsByFlow["check-in"]).toHaveLength(1);
    expect(report.reconciliation).toEqual({ new: 1, stillOpen: 0, resolved: 0 });
  });

  it("attributes a cross-session finding to every goal any of its sessions belongs to, and sets hasAnalystPass once analyst cost is recorded", () => {
    const run: Run = { id: newId(), appName, config, status: "completed", startedAt: 1000 };
    db.insertRun(run);

    const sessionA = makeSession(run.id, "check-in");
    const sessionB = makeSession(run.id, "schedule-edit");

    const finding: CrossSessionFinding = {
      id: newId(),
      runId: run.id,
      type: "recurring-dead-end",
      severity: "medium",
      description: "Both personas dead-end on /help",
      sessionIds: [sessionA.id, sessionB.id],
      matchKey: "recurring-dead-end:/help",
      createdAt: 1500,
    };
    db.insertCrossSessionFinding(finding);
    db.updateRunAnalystCost(run.id, 0.05);
    reconcileRunFindings(db, run.id, appName);

    const report = buildRunReport(db, run.id);
    expect(report.hasAnalystPass).toBe(true);
    expect(report.analystCostUsd).toBe(0.05);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.sessionIds.sort()).toEqual([sessionA.id, sessionB.id].sort());
    expect(report.findingsByFlow["check-in"]).toHaveLength(1);
    expect(report.findingsByFlow["schedule-edit"]).toHaveLength(1);
  });

  it("sorts findings by severity, then type, then match key", () => {
    const run: Run = { id: newId(), appName, config, status: "completed", startedAt: 1000 };
    db.insertRun(run);
    const session = makeSession(run.id, "check-in");

    function addFinding(severity: InSessionFinding["severity"], matchKey: string): void {
      const eventId = db.insertActionEvent({
        sessionId: session.id,
        timestamp: 1000,
        actionType: "click",
        target: "button",
        reasoning: "test",
      });
      db.insertInSessionFinding({
        id: newId(),
        sessionId: session.id,
        eventId,
        type: "console-error",
        severity,
        description: "test",
        matchKey,
        createdAt: 1000,
      });
    }
    addFinding("low", "console-error:/low");
    addFinding("critical", "console-error:/critical");
    addFinding("medium", "console-error:/medium");

    const report = buildRunReport(db, run.id);
    expect(report.findings.map((f) => f.severity)).toEqual(["critical", "medium", "low"]);
  });
});
