import { describe, expect, it } from "vitest";
import {
  buildActionPrompt,
  buildStaticSystemPrompt,
  type StaticPromptInput,
} from "../../src/actor/prompt.js";
import type { DomainPack, Goal, PersonaArchetype } from "../../src/types/index.js";

const domainPack: Pick<DomainPack, "appName"> = { appName: "Fixture App" };

const goal: Goal = {
  id: "reach-dashboard",
  description: "Reach the dashboard.",
  actionBudget: 5,
  checkpoints: [
    { id: "on-dashboard", description: "On the dashboard.", detector: "url:/dashboard" },
  ],
  successCheckpointId: "on-dashboard",
};

function makeArchetype(overrides?: Partial<PersonaArchetype["traits"]>): PersonaArchetype {
  return {
    id: "test-persona",
    name: "Test Persona",
    traits: {
      patience: 0.5,
      techSavviness: 0.5,
      deviceType: "desktop",
      familiarity: "new",
      ...overrides,
    },
  };
}

function build(overrides?: Partial<PersonaArchetype["traits"]>, routeMapContext?: string): string {
  const input: StaticPromptInput = {
    domainPack,
    archetype: makeArchetype(overrides),
    goal,
    ...(routeMapContext !== undefined ? { routeMapContext } : {}),
  };
  return buildStaticSystemPrompt(input);
}

describe("buildStaticSystemPrompt", () => {
  describe("techSavvinessFraming", () => {
    it("frames the low band (< 0.34)", () => {
      const prompt = build({ techSavviness: 0.1 });
      expect(prompt).toContain("not very comfortable with technology");
    });

    it("frames the middle band (0.34 <= x < 0.67)", () => {
      const prompt = build({ techSavviness: 0.5 });
      expect(prompt).toContain("average comfort level with technology");
    });

    it("frames the high band (>= 0.67)", () => {
      const prompt = build({ techSavviness: 0.9 });
      expect(prompt).toContain("confident, tech-savvy user");
    });
  });

  describe("deviceFraming", () => {
    it("frames mobile", () => {
      expect(build({ deviceType: "mobile" })).toContain("using a phone");
    });

    it("frames tablet", () => {
      expect(build({ deviceType: "tablet" })).toContain("using a tablet");
    });

    it("frames desktop", () => {
      expect(build({ deviceType: "desktop" })).toContain("using a desktop computer");
    });
  });

  describe("familiarityFraming", () => {
    it("frames new", () => {
      expect(build({ familiarity: "new" })).toContain("first time using this app");
    });

    it("frames returning", () => {
      expect(build({ familiarity: "returning" })).toContain("used this app a handful of times");
    });

    it("frames veteran", () => {
      expect(build({ familiarity: "veteran" })).toContain("regular, experienced user");
    });
  });

  describe("routeMapContext", () => {
    it("omits the 'been here before' section when unset", () => {
      const prompt = build();
      expect(prompt).not.toContain("You've been here before");
    });

    it("appends the 'been here before' section when set", () => {
      const prompt = build(undefined, "- /dashboard\n- /settings");
      expect(prompt).toContain("You've been here before");
      expect(prompt).toContain("- /dashboard\n- /settings");
    });
  });

  it("includes the app name, persona name, goal description, and checkpoint list", () => {
    const prompt = build();
    expect(prompt).toContain('"Fixture App"');
    expect(prompt).toContain('"Test Persona"');
    expect(prompt).toContain("Reach the dashboard.");
    expect(prompt).toContain("on-dashboard: On the dashboard.");
  });
});

describe("buildActionPrompt", () => {
  it("shows a fallback line when recentHistory is empty", () => {
    const prompt = buildActionPrompt({
      perception: { url: "http://localhost/", title: "Home", ariaSnapshot: "<snapshot>" },
      recentHistory: [],
      actionsTaken: 0,
      actionBudget: 5,
    });

    expect(prompt).toContain("You haven't taken any actions yet this session.");
    expect(prompt).not.toContain("Your recent actions this session:");
  });

  it("lists recentHistory when non-empty", () => {
    const prompt = buildActionPrompt({
      perception: {
        url: "http://localhost/dashboard",
        title: "Dashboard",
        ariaSnapshot: "<snapshot>",
      },
      recentHistory: ["navigate to /", "click #login"],
      actionsTaken: 2,
      actionBudget: 5,
    });

    expect(prompt).toContain("Your recent actions this session:\nnavigate to /\nclick #login");
    expect(prompt).not.toContain("You haven't taken any actions yet this session.");
  });

  it("includes the current page perception and remaining action budget", () => {
    const prompt = buildActionPrompt({
      perception: { url: "http://localhost/dashboard", title: "Dashboard", ariaSnapshot: "<tree>" },
      recentHistory: [],
      actionsTaken: 3,
      actionBudget: 5,
    });

    expect(prompt).toContain("Current page: http://localhost/dashboard");
    expect(prompt).toContain("Title: Dashboard");
    expect(prompt).toContain("Page contents (accessibility tree):\n<tree>");
    expect(prompt).toContain("Actions taken: 3/5.");
  });
});
