/**
 * App-specific domain pack layer — one local config file per target app.
 * Shapes are defined verbatim in CONTEXT.md ("Persona & domain pack schema").
 */

import type { Browser } from "playwright";
import type { PersonaArchetype, WeightedGoal } from "./persona.js";

export interface Goal {
  id: string;
  description: string;
  actionBudget: number;
  checkpoints: Checkpoint[];
  successCheckpointId: string;
}

export interface Checkpoint {
  id: string;
  description: string;
  /**
   * Detector DSL string evaluated after each action. Format is finalized in
   * Session 3 (planned: `url:`, `selector:`, `text:` matchers).
   */
  detector: string;
}

/**
 * Passed to a DomainPack's teardown hook (Session 4). `runStartedAt`/
 * `runEndedAt` (added per GAPS.md's S4 entry) exist specifically so a pack
 * author can implement the "sweep by timestamp window" correlation strategy
 * without needing separate SQLite access — Drover doesn't track which
 * app-side rows a run actually created, but it does always know when the
 * run started and (as of the moment teardown is invoked) ended, so at least
 * one of the two documented strategies is fully supported out of the box.
 * The other strategy (tagging synthetic data with `runId` at fill-time)
 * needs nothing further from Drover — it's already just `runId` plus
 * whatever the pack itself writes into the app during a session.
 */
export interface DomainPackTeardownContext {
  runId: string;
  targetBaseUrl: string;
  /** Raw epoch milliseconds — this run's own Run.startedAt. */
  runStartedAt: number;
  /** Raw epoch milliseconds, taken right as the run finishes and teardown is invoked. */
  runEndedAt: number;
}

/**
 * Structurally mirrors `TreelineLoginCredentials` (`src/treeline/adapter.ts`)
 * field for field, deliberately re-declared here rather than imported —
 * `src/types/` has no dependency on any other tier (every other type file
 * only imports from within `src/types/`), and this shape is plain data with
 * no treeline-specific runtime behavior, so duplicating it costs nothing and
 * keeps that layering intact.
 *
 * Credential *values* are the pack author's own responsibility to supply
 * (typically `process.env.SOME_VAR!` read at module-load time inside the
 * pack file), same precedent as `teardown`'s `HHOPS_TEST_DATABASE_URL` usage
 * — Drover doesn't introduce a separate "env var name" indirection layer on
 * top of what pack authors already do themselves elsewhere.
 */
export interface DomainPackAuthCredentials {
  loginUrl: string;
  username: string;
  password: string;
  /** Selector that must exist after login for it to count as a success. */
  successIndicator: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

/**
 * Structurally mirrors `TreelineStorageState` (`src/treeline/adapter.ts`) and,
 * one layer further down, Playwright's own `BrowserContext.storageState()`
 * return shape — deliberately re-declared rather than imported, same
 * "src/types/ has no dependency on any other Drover tier" reasoning as
 * `DomainPackAuthCredentials` above. `customLogin` implementations can return
 * the real `await context.storageState()` value directly; it's assignable
 * here by structure, no conversion needed.
 */
export interface DomainPackStorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface DomainPack {
  appName: string;
  personas: PersonaArchetype[];
  goals: Goal[];
  goalWeightsByPersona: Record<string, WeightedGoal[]>;
  /**
   * Enforced, not advisory: `restricted` packs must refuse to run when a
   * non-approved provider is configured for the actor tier (checked at
   * config-load time).
   */
  dataPolicy: "synthetic-only" | "restricted";
  /**
   * Optional config-declared cleanup hook that wipes run-created staging
   * data (CONTEXT.md "Environment & safety": "staging teardown wipes
   * everything a run created before the next one starts"). Not in
   * CONTEXT.md's verbatim schema — added in Session 4, see SESSION-LOG.md.
   * Runs finally-style: after a completed, budget-stopped, *or* crashed run.
   */
  teardown?: (ctx: DomainPackTeardownContext) => Promise<void>;
  /**
   * Optional single set of login credentials, used to reach any goal behind
   * an auth wall. Not in CONTEXT.md's verbatim schema — added once a real
   * target (Horse Haven Ops) needed it, see GAPS.md/SESSION-LOG.md. Lives on
   * `DomainPack`, not `SimConfig`: only `SimConfig` gets persisted into a
   * run's stored `Run.config` snapshot (`src/types/run.ts`), so credentials
   * placed here never enter the SQLite database at all — the same "secrets
   * never enter [persisted state]" discipline already applied to prompt
   * content and the event log, extended one layer further.
   *
   * `runDiscovery` calls `TreelineAdapter.performLogin` with this exactly
   * once per run (not once per session — login is a real, possibly
   * rate-limited network operation) and reuses the resulting `storageState`
   * across every persona-session in the run. A pack with goals that don't
   * need auth simply omits this field; a pack whose goals need *different*
   * roles/accounts isn't supported yet by this single-credentials-per-run
   * shape (see GAPS.md).
   */
  auth?: DomainPackAuthCredentials;
  /**
   * Escape hatch alongside `auth`, for apps whose login can't be driven by a
   * generic loginUrl/username/password/CSS-selector form — the concrete case
   * that forced this: Horse Haven Ops uses Clerk with password sign-in
   * disabled entirely (`skipPasswordRequirement: true` on every test
   * account), authenticated instead via `@clerk/testing`'s testing-token
   * mechanism (`clerk.signIn({ page, emailAddress })`), which has no login
   * form for `DomainPackAuthCredentials`' selectors to target at all. A pack
   * author supplies their own async login function instead; Drover calls it
   * exactly once per run (same timing/reuse contract `auth` already has —
   * see below) and threads the returned storageState into every session the
   * same way. Mutually exclusive with `auth` — a pack setting both is a
   * config error (`ConflictingAuthConfigError`, checked before the run
   * starts), since there's no sensible precedence rule to guess at for two
   * different login mechanisms declared on the same pack.
   *
   * Receives the run's `targetBaseUrl` (from `SimConfig`, not duplicated
   * into the pack itself) so the implementation doesn't need its own
   * hardcoded copy of a value the orchestrator already has in scope at the
   * one call site.
   */
  customLogin?: (browser: Browser, targetBaseUrl: string) => Promise<DomainPackStorageState>;
}
