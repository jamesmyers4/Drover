/**
 * Reference GraderPack (FUTUREPLAN.md Grader Session 8) — a full, runnable
 * example so anyone building a real GraderPack (Shenny's own session is the
 * named first consumer) has something to fork instead of starting from
 * scratch, mirroring `examples/toy-app`'s role for the simulation stack.
 *
 * Five Cases across two named rubrics, deliberately spanning the full range
 * a real Grading Run should demonstrate: a clean pass, a clean fail, and a
 * genuinely ambiguous Case (a reply that's factually grounded on its core
 * claim but tacks on an unsupported embellishment) that real-model probing
 * against this exact pack (`qwen3:8b` + `claude-haiku-4-5`, see the
 * session's own plain-language summary) confirmed actually splits the two
 * judges some — not all — of the time, genuinely exercising escalation for
 * real rather than a scripted stand-in for it. Two more Cases (obviously
 * grounded / obviously fabricated) round out the accuracy rubric with clean
 * agreement on both ends, so the reference run shows the full range: clean
 * pass, clean fail, and real disagreement, not just the interesting middle
 * case in isolation. All content is synthetic/fabricated toy copy —
 * `dataPolicy: "synthetic-only"` is correct here, not a placeholder.
 */

import type { GraderPack } from "../../src/grader/types.js";

const toneRubric = {
  key: "tone-eval",
  description: "Checks whether a volunteer-facing reply reads as warm and appreciative.",
  checks: [
    {
      name: "on-brand-tone",
      description:
        "Reads as warm and appreciative, not clinical, dismissive, or curt — the kind of reply a volunteer coordinator who genuinely values their volunteers would send.",
      scoringType: "boolean" as const,
    },
  ],
};

const accuracyRubric = {
  key: "accuracy-eval",
  description:
    "Checks whether a reply's factual claims are actually supported by the provided source data — Layer 5's faithfulness/groundedness framing is aimed squarely at this rubric.",
  checks: [
    {
      name: "factual-accuracy-score",
      description:
        "How well the reply's claims are supported by the provided source data (5 = every claim is directly grounded in the source, 1 = the reply fabricates or contradicts it).",
      scoringType: "numeric" as const,
      numericTolerance: 1,
      passThreshold: { comparison: "gte" as const, value: 4 },
    },
  ],
};

const pack: GraderPack = {
  appName: "Paddock Pals Grader reference pack (toy example)",
  rubrics: {
    "tone-eval": toneRubric,
    "accuracy-eval": accuracyRubric,
  },
  loadCases: () => [
    {
      input: { context: "A volunteer just completed their first shift." },
      output: {
        text: "Thank you so much for your first shift — we're thrilled to have you on the team!",
      },
      rubric: "tone-eval",
    },
    {
      input: { context: "A volunteer asks a simple scheduling question." },
      output: { text: "Not my problem. Check the site." },
      rubric: "tone-eval",
    },
    {
      input: {
        sourceData: "12 new volunteers signed up in the last 30 days.",
        question: "How many new volunteers joined this month?",
      },
      output: { text: "12 new volunteers joined this month — great turnout!" },
      rubric: "accuracy-eval",
    },
    {
      // The genuinely ambiguous Case: the core number ("a dozen" ≈ 12) is
      // accurate, but the trailing claim about a "broader trend across all
      // our programs" has no support in the source data at all. Real
      // probing against this exact pair of judges found this split them —
      // one judge scored it near-perfect (focused on the accurate core
      // claim), the other docked it for the unsupported embellishment —
      // often enough to trigger a real escalation Task, though not on every
      // single run (real models are not perfectly deterministic; see the
      // session's own plain-language summary for what the actual reference
      // run showed).
      input: {
        sourceData: "12 new volunteers signed up in the last 30 days.",
        question: "How many new volunteers joined this month?",
      },
      output: {
        text: "Around a dozen new volunteers joined this month, and it's part of a broader trend of increasing engagement across all our programs this year.",
      },
      rubric: "accuracy-eval",
    },
    {
      input: {
        sourceData: "12 new volunteers signed up in the last 30 days.",
        question: "How many new volunteers joined this month?",
      },
      output: { text: "About 50 new volunteers joined this month — incredible growth!" },
      rubric: "accuracy-eval",
    },
  ],
  dataPolicy: "synthetic-only",
};

export default pack;
