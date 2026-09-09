# Soak mode drives the target over direct API calls, not the browser-driven Actor tier

**Status:** accepted

Drover's core identity is persona-driven browser simulation — the Actor tier exists specifically to reason about what a real user would click and notice. It would be the obvious default to extend for a new "run for hours" mode. Soak mode doesn't use it.

Two facts pushed the other way. First, Shenny's own test infrastructure already proves direct-API driving works for exactly this shape of traffic: `tests/load/scenarios/ai-routes.ts` authenticates via a bearer token and posts straight to `/api/message-analysis/analyze`, `/api/clarity/sessions/.../messages`, etc., treating `402`/`429` as correct gating responses rather than failures — the auth mechanism and the "what counts as a real error" distinction are both already solved, proven infrastructure, not something Drover would be inventing. Second, CTS.md's own turn schema (`requestPayload`/`responsePayload`/`httpStatus`) is HTTP-shaped, not UI-action-shaped — the design was already reaching for this before the decision was made explicit.

The trade-off given up: browser-level UI regressions (a broken button, a client-side crash) are invisible to an API-driven soak run. That's an acceptable gap — Discovery mode already covers UI-level exploration, and Soak mode's actual purpose (surfacing rare AI-pipeline content bugs and drift under volume) doesn't need a rendered page to find them. Asking a small local model (llama3.1:8b) to reliably drive aria-ref-based Playwright actions unattended for hours would also have been a materially less-proven combination than Haiku already validated for Discovery mode — a real reliability risk for a run nobody is watching.

**Consequence:** Soak mode's turn dispatch is plain HTTP (`fetch`) against `SoakBlueprint.targetBaseUrl`, authenticated via an env-sourced bearer token that never enters prompt content (same "secrets stay in the orchestrator's HTTP layer" principle as every other tier). No `BrowserSession`, no Playwright, no `DomainPack.auth`/`customLogin`.
