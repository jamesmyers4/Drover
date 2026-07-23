/**
 * Thin adapter over treeLine's `@treeline/acquire` export surface. Drover
 * consumes treeLine as a library for exactly three capabilities (CONTEXT.md
 * "Relationship to treeLine"): storageState session re-seeding, auth-wall
 * detection, and seed-URL resolution. Anything treeLine doesn't expose gets
 * stubbed here and logged in TREELINE-GAPS.md — never reimplemented.
 *
 * treeLine is not an npm dependency: it's loaded at runtime from the sibling
 * repo's built output (a pnpm workspace that isn't published), so Drover
 * installs and runs standalone when treeLine is absent.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";

/** Mirrors `LoginCredentials` from @treeline/acquire. */
export interface TreelineLoginCredentials {
  loginUrl: string;
  username: string;
  password: string;
  /** Selector that must exist after login for it to count as a success. */
  successIndicator: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

/** Mirrors Playwright's `storageState()` shape, as re-exported by treeLine. */
export interface TreelineStorageState {
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

export interface ResolvedSeedUrl {
  resolvedUrl: string;
  html: string | null;
}

export interface TreelineAdapter {
  /** "treeline" when the real library loaded; "stub" otherwise. */
  readonly kind: "treeline" | "stub";
  /**
   * Log in once and capture storageState for re-seeding later sessions.
   * The returned state contains auth cookies/tokens — it goes to the browser
   * context only, never into prompt content.
   */
  performLogin(browser: Browser, creds: TreelineLoginCredentials): Promise<TreelineStorageState>;
  /** treeLine's auth-validity check: not parked on the login URL + indicator present. */
  checkAuthStillValid(page: Page, successIndicator: string, loginUrl: string): Promise<boolean>;
  /**
   * Auth-wall heuristic on a live page. treeLine's full two-mechanism
   * detection is only reachable through its capture pipeline (see
   * TREELINE-GAPS.md), so both adapter kinds use the same lightweight
   * password-field check treeLine applies to captured forms.
   */
  detectAuthWall(page: Page): Promise<boolean>;
  /** Resolve a crawl-target/seed URL (follows redirects, verifies auth if provided). */
  resolveSeedUrl(
    browser: Browser,
    url: string,
    auth?: { storageState: TreelineStorageState; successIndicator: string; loginUrl: string },
  ): Promise<ResolvedSeedUrl>;
}

/** Thrown by the stub when a capability genuinely requires treeLine. */
export class TreelineUnavailableError extends Error {
  constructor(capability: string) {
    super(
      `treeLine is not available: ${capability} requires the @treeline/acquire library. ` +
        "Build the sibling treeLine repo (pnpm build in ../treeLine) or set DROVER_TREELINE_PATH.",
    );
    this.name = "TreelineUnavailableError";
  }
}

/** The subset of @treeline/acquire's module surface Drover calls. */
interface TreelineAcquireModule {
  performLogin(
    browser: Browser,
    creds: TreelineLoginCredentials,
    options?: { insecureCerts?: boolean },
  ): Promise<TreelineStorageState>;
  checkAuthStillValid(page: Page, indicator: string, loginUrl: string): Promise<boolean>;
  resolveSeedUrlWithBrowser(
    url: string,
    browser: Browser,
    options?: {
      authSession?: {
        storageState: TreelineStorageState;
        successIndicator: string;
        loginUrl: string;
      };
    },
  ): Promise<ResolvedSeedUrl>;
}

/**
 * Same heuristic treeLine applies to captured forms (a password input present
 * and no auth session), run against the live page instead of a capture.
 */
async function passwordFieldPresent(page: Page): Promise<boolean> {
  return (await page.locator("input[type=password]").count()) > 0;
}

class RealTreelineAdapter implements TreelineAdapter {
  readonly kind = "treeline";

  constructor(private readonly mod: TreelineAcquireModule) {}

  performLogin(browser: Browser, creds: TreelineLoginCredentials): Promise<TreelineStorageState> {
    return this.mod.performLogin(browser, creds);
  }

  checkAuthStillValid(page: Page, successIndicator: string, loginUrl: string): Promise<boolean> {
    return this.mod.checkAuthStillValid(page, successIndicator, loginUrl);
  }

  detectAuthWall(page: Page): Promise<boolean> {
    return passwordFieldPresent(page);
  }

  resolveSeedUrl(
    browser: Browser,
    url: string,
    auth?: { storageState: TreelineStorageState; successIndicator: string; loginUrl: string },
  ): Promise<ResolvedSeedUrl> {
    return this.mod.resolveSeedUrlWithBrowser(url, browser, auth ? { authSession: auth } : {});
  }
}

class StubTreelineAdapter implements TreelineAdapter {
  readonly kind = "stub";

  performLogin(): Promise<TreelineStorageState> {
    return Promise.reject(new TreelineUnavailableError("performLogin (storageState re-seeding)"));
  }

  checkAuthStillValid(): Promise<boolean> {
    return Promise.reject(new TreelineUnavailableError("checkAuthStillValid"));
  }

  detectAuthWall(page: Page): Promise<boolean> {
    return passwordFieldPresent(page);
  }

  resolveSeedUrl(): Promise<ResolvedSeedUrl> {
    return Promise.reject(new TreelineUnavailableError("resolveSeedUrl"));
  }
}

function candidateTreelinePaths(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/treeline/ (tsx) or dist/treeline/ (built) — repo root is two levels up.
  const repoRoot = path.resolve(here, "..", "..");
  const candidates: string[] = [];
  if (process.env.DROVER_TREELINE_PATH) {
    candidates.push(process.env.DROVER_TREELINE_PATH);
  }
  candidates.push(path.resolve(repoRoot, "..", "treeLine", "packages", "acquire"));
  return candidates;
}

/**
 * Load the real adapter from a built treeLine checkout, or fall back to the
 * stub. Resolution order: `DROVER_TREELINE_PATH` (points at the acquire
 * package dir), then the sibling `../treeLine/packages/acquire` checkout.
 */
export async function createTreelineAdapter(explicitPath?: string): Promise<TreelineAdapter> {
  const candidates = explicitPath ? [explicitPath] : candidateTreelinePaths();
  for (const candidate of candidates) {
    const entry = path.join(candidate, "dist", "index.js");
    if (!existsSync(entry)) continue;
    try {
      const mod = (await import(pathToFileURL(entry).href)) as TreelineAcquireModule;
      if (
        typeof mod.performLogin === "function" &&
        typeof mod.checkAuthStillValid === "function" &&
        typeof mod.resolveSeedUrlWithBrowser === "function"
      ) {
        return new RealTreelineAdapter(mod);
      }
    } catch {
      // Fall through to the next candidate (or the stub) — a broken build
      // must not take the harness down.
    }
  }
  return new StubTreelineAdapter();
}
