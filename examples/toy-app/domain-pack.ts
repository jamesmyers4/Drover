/**
 * Toy/generic example domain pack — a full, runnable reference so someone
 * adopting Drover has a real end-to-end example to fork instead of writing a
 * `DomainPack` from scratch (CONTEXT.md "Open source packaging"). Targets
 * `examples/toy-app/site-server.ts`, a small local app with an intentional
 * bug (see `sim.config.ts` and the README quickstart for how to run both).
 *
 * Reuses Drover's own shipped core archetypes (`examples/archetypes.ts`)
 * rather than inventing pack-specific ones — exactly the reuse CONTEXT.md
 * calls out as "the actual open-source value."
 */

import type { DomainPack } from "../../src/types/index.js";
import { distracted, firstTimerCautious, impatientRushed, powerUserMobile } from "../archetypes.js";

const domainPack: DomainPack = {
  appName: "Paddock Pals (toy example)",
  personas: [impatientRushed, firstTimerCautious, distracted, powerUserMobile],
  goals: [
    {
      id: "sign-up",
      description: "Sign up to volunteer, starting from the home page.",
      actionBudget: 6,
      checkpoints: [
        {
          id: "reached-thanks",
          description: "Reached the signup confirmation page.",
          detector: "url:/signup/thanks",
        },
      ],
      successCheckpointId: "reached-thanks",
    },
    {
      id: "browse-horses",
      description:
        "Browse the list of horses from the home page. If curious, try loading more horses.",
      actionBudget: 5,
      checkpoints: [
        {
          id: "reached-horses",
          description: "Reached the horse list page.",
          detector: "url:/horses",
        },
      ],
      successCheckpointId: "reached-horses",
    },
  ],
  goalWeightsByPersona: {
    // In a hurry: wants the fastest path to "done," which here is signing up.
    "impatient-rushed": [
      { goalId: "sign-up", weight: 4 },
      { goalId: "browse-horses", weight: 1 },
    ],
    // Never used the app before: looks around before committing to anything.
    "first-timer-cautious": [
      { goalId: "browse-horses", weight: 3 },
      { goalId: "sign-up", weight: 2 },
    ],
    // Wanders off-goal easily — heavier on open-ended browsing, where the
    // "Load more" bug lives.
    distracted: [
      { goalId: "browse-horses", weight: 4 },
      { goalId: "sign-up", weight: 1 },
    ],
    // Knows exactly what they want and drives straight to it.
    "power-user-mobile": [{ goalId: "sign-up", weight: 1 }],
  },
  dataPolicy: "synthetic-only",
  // This toy app has no real database — nothing to sweep. A real pack
  // (see README.md's "Writing a domain pack") would tag synthetic data with
  // `ctx.runId` at fill-time, or delete by `[ctx.runStartedAt, ctx.runEndedAt]`
  // window, using this same hook shape.
  teardown: async (ctx) => {
    console.log(
      `[teardown] no persistent data to clean up for run ${ctx.runId} (toy example has no database)`,
    );
  },
};

export default domainPack;
