import type { SimConfig } from "../../src/types/index.js";

// Small-scale config for mechanical validation of new goals/checkpoints/auth before
// committing to a full sim.config.ts run (SESSION-10-PLAN.md's Session 3/4 pattern).
// orgSize 4 with 1 week / 1 session-per-week ensures every one of domain-pack.ts's four
// personas gets exactly one round-robin-assigned session, so every goal pool actually gets
// exercised at least once. ~$0.04 real cost at current per-session pricing.
const config: SimConfig = {
  targetBaseUrl: "http://localhost:3000",
  runDimensions: {
    orgSize: 4,
    simulatedWeeks: 1,
    sessionsPerPersonaPerWeek: 1,
  },
  budget: {
    runCeilingUsd: 0.5,
    perSessionSoftCapUsd: 0.25,
    analystCeilingUsd: 0.25,
  },
  modelRouting: {
    actor: { provider: "anthropic", model: "claude-haiku-4-5" },
    analyst: { provider: "anthropic", model: "claude-sonnet-5" },
  },
};

export default config;
