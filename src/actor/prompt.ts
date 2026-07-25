/**
 * Prompt assembly for the actor tier (CONTEXT.md "Architecture: three tiers"
 * / CLAUDE.md Session 3). Two blocks, kept deliberately separate so the
 * provider can cache one and not the other:
 *
 *   - static block: domain pack, archetype, checkpoint schema (descriptions
 *     only — not the detector DSL, which is our instrumentation, never
 *     shown to the persona), optional treeLine route map. Identical for
 *     every action in a session, so it's cached once per session.
 *   - per-action block: current page perception, recent history, remaining
 *     budget. Small, changes every call, never cached.
 *
 * Trait shaping (CLAUDE.md: "Persona traits actually shape behavior"):
 * `techSavviness` changes the system-prompt framing; `patience` shapes
 * retry/wait behavior in the loop (src/actor/loop.ts), not the prompt text.
 * Traits are treated as 0..1 normalized values (not specified numerically in
 * CONTEXT.md — documented in SESSION-LOG.md's Session 3 entry).
 */

import type { DomainPack, Goal, PersonaArchetype } from "../types/index.js";

function techSavvinessFraming(techSavviness: number): string {
  if (techSavviness < 0.34) {
    return "You are not very comfortable with technology. Unfamiliar icons, jargon, or multi-step flows slow you down and can confuse you. You read labels carefully rather than guessing.";
  }
  if (techSavviness < 0.67) {
    return "You have an average comfort level with technology. You can follow reasonably clear UI, but you don't go looking for hidden or advanced features.";
  }
  return "You are a confident, tech-savvy user. You move quickly, try shortcuts, and aren't afraid of slightly unfamiliar UI patterns.";
}

function deviceFraming(deviceType: PersonaArchetype["traits"]["deviceType"]): string {
  switch (deviceType) {
    case "mobile":
      return "You are using a phone — small screen, touch input.";
    case "tablet":
      return "You are using a tablet — medium screen, touch input.";
    case "desktop":
      return "You are using a desktop computer with a mouse and keyboard.";
  }
}

function familiarityFraming(familiarity: PersonaArchetype["traits"]["familiarity"]): string {
  switch (familiarity) {
    case "new":
      return "This is your first time using this app. You have no prior knowledge of its layout or routes.";
    case "returning":
      return "You've used this app a handful of times before and have some sense of where things are.";
    case "veteran":
      return "You're a regular, experienced user of this app.";
  }
}

export interface StaticPromptInput {
  domainPack: Pick<DomainPack, "appName">;
  archetype: PersonaArchetype;
  goal: Goal;
  /** From buildRouteMapContext — undefined for `familiarity: new` or when unavailable. */
  routeMapContext?: string;
}

/** The cacheable, per-session-constant system prompt block. */
export function buildStaticSystemPrompt(input: StaticPromptInput): string {
  const { domainPack, archetype, goal } = input;
  const checkpointList = goal.checkpoints.map((c) => `- ${c.id}: ${c.description}`).join("\n");

  const sections = [
    `You are simulating a real human user of the web app "${domainPack.appName}", named "${archetype.name}".`,
    `${techSavvinessFraming(archetype.traits.techSavviness)}`,
    `${deviceFraming(archetype.traits.deviceType)}`,
    `${familiarityFraming(archetype.traits.familiarity)}`,
    `Your goal: ${goal.description}`,
    `Milestones that mark progress toward this goal (for your general sense of the journey — you do not need to name these explicitly):\n${checkpointList}`,
    "Perceive the current page, then decide on exactly one next action. Respond only through the decide_action tool — never as free text. Give one short sentence of reasoning for each action, as a real user might think to themselves, not a chain of detailed deliberation.",
  ];

  if (input.routeMapContext) {
    sections.push(
      `You've been here before and vaguely recall some pages you can reach:\n${input.routeMapContext}`,
    );
  }

  return sections.join("\n\n");
}

export interface ActionPromptInput {
  perception: { url: string; title: string; ariaSnapshot: string };
  /** Prior actions this session, most recent last, already formatted as short lines. */
  recentHistory: string[];
  actionsTaken: number;
  actionBudget: number;
}

/** The small, non-cached per-action user prompt. */
export function buildActionPrompt(input: ActionPromptInput): string {
  const { perception } = input;
  const historyBlock =
    input.recentHistory.length > 0
      ? `Your recent actions this session:\n${input.recentHistory.join("\n")}`
      : "You haven't taken any actions yet this session.";

  return [
    `Current page: ${perception.url}`,
    `Title: ${perception.title}`,
    `Page contents (accessibility tree):\n${perception.ariaSnapshot}`,
    historyBlock,
    `Actions taken: ${input.actionsTaken}/${input.actionBudget}.`,
    "What do you do next?",
  ].join("\n\n");
}
