import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DroverDb, newId } from "../../src/db/database.js";
import {
  extractDiscoveredRoutes,
  NoRoutesDiscoveredError,
  SourceRunNotFoundError,
} from "../../src/stampede/routes.js";
import type { PersonaSession, Run, SimConfig } from "../../src/types/index.js";

const config: SimConfig = {
  targetBaseUrl: "https://staging.example.test",
  runDimensions: { orgSize: 1, simulatedWeeks: 1, sessionsPerPersonaPerWeek: 1 },
  budget: { runCeilingUsd: 1, perSessionSoftCapUsd: 1 },
  modelRouting: {
    actor: { provider: "scripted", model: "scripted" },
    analyst: { provider: "scripted", model: "scripted" },
  },
};

describe("extractDiscoveredRoutes", () => {
  let db: DroverDb;

  beforeEach(() => {
    db = new DroverDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function makeRun(): Run {
    const run: Run = {
      id: newId(),
      appName: "fixture-app",
      config,
      status: "completed",
      startedAt: 1000,
    };
    db.insertRun(run);
    return run;
  }

  function makeSession(runId: string): PersonaSession {
    const session: PersonaSession = {
      id: newId(),
      runId,
      personaId: "impatient-rushed",
      goalId: "check-in",
      status: "completed",
      startedAt: 1000,
      endedAt: 2000,
    };
    db.insertSession(session);
    return session;
  }

  it("throws SourceRunNotFoundError for an unknown run id", () => {
    expect(() => extractDiscoveredRoutes(db, "no-such-run")).toThrow(SourceRunNotFoundError);
  });

  it("throws NoRoutesDiscoveredError when the run has no navigate events", () => {
    const run = makeRun();
    const session = makeSession(run.id);
    db.insertActionEvent({
      sessionId: session.id,
      timestamp: 1000,
      actionType: "click",
      target: "button#save",
      reasoning: "test",
    });
    expect(() => extractDiscoveredRoutes(db, run.id)).toThrow(NoRoutesDiscoveredError);
  });

  it("dedupes and normalizes routes across sessions, ignoring non-navigate events", () => {
    const run = makeRun();
    const sessionA = makeSession(run.id);
    const sessionB = makeSession(run.id);

    db.insertActionEvent({
      sessionId: sessionA.id,
      timestamp: 1000,
      actionType: "navigate",
      target: "https://staging.example.test/dashboard?tab=overview",
      reasoning: "test",
    });
    db.insertActionEvent({
      sessionId: sessionA.id,
      timestamp: 1100,
      actionType: "click",
      target: "button#save",
      reasoning: "test",
    });
    db.insertActionEvent({
      sessionId: sessionB.id,
      timestamp: 1000,
      actionType: "navigate",
      target: "https://staging.example.test/dashboard?tab=settings",
      reasoning: "test",
    });
    db.insertActionEvent({
      sessionId: sessionB.id,
      timestamp: 1200,
      actionType: "navigate",
      target: "https://staging.example.test/horses",
      reasoning: "test",
    });

    expect(extractDiscoveredRoutes(db, run.id)).toEqual(["/dashboard", "/horses"]);
  });
});
