# Drover

This README is a skeleton — the full quickstart, domain pack authoring guide, data routing & privacy section, and model routing/cost table land in Session 8. What exists so far documents pieces later sessions depend on.

## Checkpoint detector DSL

A `Checkpoint.detector` (see `src/types/domain-pack.ts`) is a string of the form `kind:value`, evaluated against the live page after each actor action (`src/actor/checkpoint.ts`). Three kinds:

| Kind | Example | Matches when... |
| --- | --- | --- |
| `url:` | `url:/dashboard` | the current page URL contains the substring |
| `selector:` | `selector:#confirmation-banner` | an element matching the CSS selector exists on the page |
| `text:` | `text:thank you for signing up` | the page's visible body text contains the substring (case-insensitive) |

Detectors are Drover's own instrumentation for measuring progress — they are never shown to the persona/model, which only sees each `Checkpoint.description`.
