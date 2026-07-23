# TREELINE-GAPS.md — treeLine limitations surfaced by Drover

treeLine-specific gaps hit during Drover builds and runs (auth patterns it doesn't handle, crawl gaps, session-seeding edge cases). Kept separate from GAPS.md so the two feedback loops don't tangle; entries get periodically converted into treeLine issues or session briefs (per CONTEXT.md's Learning Loop).

## 2026-07-23 (S2) — Auth-wall detection is not exported standalone

`@treeline/acquire` exports `checkAuthStillValid` (mechanism 1: login-URL comparison + success-indicator presence), but mechanism 2 — the password-field heuristic — lives inline in `capturePage`'s capture pipeline (`capture.ts` ~line 547, `detectAuthWall` option) and only surfaces as a thrown `AuthWallError` after a full capture (axe scan, screenshot, color palette, network log). Drover needs a cheap per-page auth-wall check without paying for a full capture, so its adapter re-runs the same one-line heuristic (`input[type=password]` present) against the live page. Ask: export a standalone `detectAuthWall(page): Promise<boolean>` (ideally both mechanisms) from `@treeline/acquire` so consumers get the real two-mechanism detection; Drover's adapter (`src/treeline/adapter.ts` → `detectAuthWall`) would then delegate instead of duplicating the heuristic.

## 2026-07-23 (S2) — Not consumable as an npm dependency

treeLine is a private pnpm workspace; `@treeline/acquire` isn't published, so Drover can't declare it in `package.json` (a `file:` dep would break `npm install` for anyone without the sibling checkout). Drover loads it at runtime via dynamic import of `../treeLine/packages/acquire/dist/index.js` (override: `DROVER_TREELINE_PATH`), falling back to a stub. Works, but requires treeLine to have been built (`dist/` present) and silently downgrades to the stub on a broken/missing build. If treeLine packages ever get published (even to a private registry), Drover should switch to an optional peer dependency.
