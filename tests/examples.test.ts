import { describe, expect, it } from "vitest";
import { CORE_ARCHETYPES } from "../examples/archetypes.js";
import { startToyAppServer } from "../examples/toy-app/site-server.js";
import { loadDefaultExport } from "../src/orchestrator/config-loader.js";
import type { DomainPack, SimConfig } from "../src/types/index.js";

describe("examples/archetypes.ts", () => {
  it("ships the four core archetypes from CONTEXT.md's persona layer", () => {
    expect(CORE_ARCHETYPES).toHaveLength(4);
    expect(new Set(CORE_ARCHETYPES.map((a) => a.id)).size).toBe(4);
    for (const archetype of CORE_ARCHETYPES) {
      expect(archetype.traits.patience).toBeGreaterThanOrEqual(0);
      expect(archetype.traits.patience).toBeLessThanOrEqual(1);
      expect(archetype.traits.techSavviness).toBeGreaterThanOrEqual(0);
      expect(archetype.traits.techSavviness).toBeLessThanOrEqual(1);
    }
  });
});

describe("examples/toy-app", () => {
  it("domain-pack.ts loads as a valid DomainPack", async () => {
    const pack = await loadDefaultExport<DomainPack>(
      "examples/toy-app/domain-pack.ts",
      "toy example domain pack",
    );
    expect(pack.appName).toBe("Paddock Pals (toy example)");
    expect(pack.personas).toHaveLength(4);
    expect(pack.dataPolicy).toBe("synthetic-only");
    expect(Object.keys(pack.goalWeightsByPersona).sort()).toEqual(
      pack.personas.map((p) => p.id).sort(),
    );
    // Every goal referenced by a weighted goal pool must actually exist.
    const goalIds = new Set(pack.goals.map((g) => g.id));
    for (const weightedGoals of Object.values(pack.goalWeightsByPersona)) {
      for (const { goalId } of weightedGoals) {
        expect(goalIds.has(goalId)).toBe(true);
      }
    }
  });

  it("sim.config.ts loads as a valid SimConfig pointed at the toy server's default port", async () => {
    const config = await loadDefaultExport<SimConfig>(
      "examples/toy-app/sim.config.ts",
      "toy example sim config",
    );
    expect(config.targetBaseUrl).toBe("http://127.0.0.1:4173");
    expect(config.modelRouting.actor.provider).toBe("anthropic");
  });

  it("site-server.ts serves the routes the domain pack's goals and checkpoints expect", async () => {
    const server = await startToyAppServer(0);
    try {
      const home = await fetch(server.baseUrl);
      expect(home.status).toBe(200);

      const horses = await fetch(`${server.baseUrl}/horses`);
      expect(horses.status).toBe(200);

      const signup = await fetch(`${server.baseUrl}/signup`);
      expect(signup.status).toBe(200);

      const thanks = await fetch(`${server.baseUrl}/signup/thanks`);
      expect(thanks.status).toBe(200);

      // The intentional bug the toy example exists to demonstrate.
      const loadMore = await fetch(`${server.baseUrl}/api/horses/more`);
      expect(loadMore.status).toBe(500);
    } finally {
      await server.close();
    }
  });
});
