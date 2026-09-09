# Soak mode is its own subsystem, not a DomainPack/SimConfig extension

**Status:** accepted

Once Soak mode drives a target over direct API calls instead of the browser (ADR 0006), `DomainPack`'s core fields — `personas`, `goals`, `checkpoints`, `successCheckpointId`, `auth`/`customLogin`, `teardown`'s browser-context shape — stop applying. A "continuous" field bolted onto `SimConfig` would leave most of that schema unused or repurposed awkwardly for something that isn't running personas through goals at all.

This repo already has two precedents for exactly this situation. Stampede reuses only the browser-launch primitives it actually needs (`launchBrowser`/`contextOptionsForDevice`) while keeping its own tables (`stampede_runs`, `stampede_route_results`) and its own runner, because a load-test worker doesn't semantically fit the `sessions` FK. Grader went further and became a fully separate subsystem — own schema, own types, own CLI subcommand, own budget/`dataPolicy` machinery — reusing shared low-level infra (the migration runner, the budget-ceiling pattern, the `ModelProvider` shape) opportunistically rather than being folded into the tier stack.

**Decided:** Soak mode follows the Grader precedent — `src/soak/` (types, storage, scheduler, provider-reuse, CLI wiring), its own SQLite file, its own `drover soak <run|analyze|report>` CLI subcommand. It reuses what genuinely applies (the generic migration-runner base class Grader Session 1 already extracted, `OllamaModelProvider`'s HTTP-calling pattern, `src/stampede/metrics.ts`'s percentile math, the budget-ceiling pattern) without inheriting `DomainPack`'s goal/checkpoint/persona shape it has no use for.
