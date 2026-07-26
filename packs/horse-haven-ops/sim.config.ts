import type { SimConfig } from "../../src/types/index.js";

const config: SimConfig = {
  targetBaseUrl: "http://localhost:3000",
  runDimensions: {
    orgSize: 4,
    simulatedWeeks: 3,
    sessionsPerPersonaPerWeek: 2,
  },
  budget: {
    runCeilingUsd: 3,
    perSessionSoftCapUsd: 0.25,
    analystCeilingUsd: 1,
  },
  modelRouting: {
    actor: { provider: "anthropic", model: "claude-haiku-4-5" },
    analyst: { provider: "anthropic", model: "claude-sonnet-5" },
  },
};

export default config;
