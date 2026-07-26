/**
 * Sim config for the toy example. Targets `examples/toy-app/site-server.ts`'s
 * fixed default port — start that server first (see README.md's quickstart),
 * then point `drover run` at this file.
 */

import type { SimConfig } from "../../src/types/index.js";

const config: SimConfig = {
  targetBaseUrl: "http://127.0.0.1:4173",
  runDimensions: {
    orgSize: 4,
    simulatedWeeks: 1,
    sessionsPerPersonaPerWeek: 2,
  },
  budget: {
    runCeilingUsd: 1,
    perSessionSoftCapUsd: 0.25,
    analystCeilingUsd: 0.5,
  },
  modelRouting: {
    actor: { provider: "anthropic", model: "claude-haiku-4-5" },
    analyst: { provider: "anthropic", model: "claude-sonnet-5" },
  },
};

export default config;
