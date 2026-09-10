# Wiring Grader into a consuming repo's CI

For whoever wires CI around `drover grade` in a consuming repo (Shenny is the
named first consumer — see FUTUREPLAN.md's closing "Notes for whoever picks
up the Shenny-side session"). This is a deployment-side document, not code
Drover builds — read it in full before assuming standard GitHub Actions (or
any standard cloud-hosted runner) just works. It doesn't, for a reason that
has nothing to do with `drover grade`'s own behavior.

See `docs/adr/0005-grader-ci-wiring.md` for the full decision record this
document implements. This file is the practical "how do I actually set this
up" companion to that ADR.

## 1. The real blocker: judge-pool network reachability

`drover grade`'s default judge pool is local Ollama installs on your own
hardware (FUTUREPLAN.md's hardware layout — two machines on a home network,
for example). A standard cloud-hosted CI runner (GitHub-hosted, most SaaS CI
providers) has **no network path** to those boxes. This is the actual
blocker CI wiring has to solve — not `drover grade`'s exit code or output
format, which already work fine in any environment.

**v1 supports CI wiring only via a self-hosted runner on the same network as
your judge-pool boxes.** Concretely: install your CI provider's self-hosted
runner agent on a machine that can reach your Ollama install(s) (the same
box, or one on the same LAN/VPN), and point your CI job at that runner
instead of a hosted one.

A `synthetic-only` GraderPack has a secondary option: skip local judges
entirely and route every layer to Anthropic (a standard cloud runner has
outbound internet access, so this needs no self-hosted runner at all). This
is a distinct, secondary path — not the default, and not the expected shape
for a `restricted` pack. If your pack is `restricted` (real user data,
proprietary content, anything that shouldn't leave your network), the
self-hosted-runner path above is the only supported one; do not route a
`restricted` pack's Cases to a hosted provider just to avoid setting up a
self-hosted runner.

## 2. New exposure surface: your CI system can now reach the judge-pool boxes

Before CI wiring, only whoever runs `drover grade` locally has network
access to your judge-pool boxes. Once a self-hosted runner is wired in, **any
CI-triggered job now has that same network reach** — anyone who can trigger
your CI (a PR from a fork, a scheduled job, a webhook) can, transitively,
reach machines holding your GraderPack's Case content.

For a `restricted` pack, this is a third exposure dimension to think through
deliberately, alongside:
- which model sees the content (already gated by `dataPolicy`/
  `allowHostedEscalation` — see ADR 0002),
- where results land at rest (`grader.sqlite`'s own data-at-rest posture —
  see ADR 0002's closing note),
- and now, **what network segment can reach the judge-pool boxes** once a
  CI job's own credentials/triggers are in the mix.

This isn't solved by anything in Drover's code — it's a real infrastructure
decision for your specific CI provider and network layout (runner isolation,
which branches/triggers can run the self-hosted job, whether the runner box
itself needs its own network segmentation from the judge-pool boxes). Treat
it with the same seriousness as any other credential/network-boundary
decision in your deployment, not as an afterthought once the runner is
"just working."

## 3. Run scope: full runs on a schedule, not a fast PR gate

v1 has no reduced/fast "PR-gating subset" mode. CI wiring runs the *same*
full Grading Run (every Case, every layer, per-Check consensus, sequential
dispatch) that any other `drover grade` invocation does. The expected
trigger shape is a **schedule** — nightly or on-merge-to-main — not a check
that blocks every PR. If your team wants PR-blocking Grader feedback, that's
a real, deferred idea (a reduced/fast subset mode) that doesn't exist yet;
don't try to force today's full-run shape into a PR gate and expect fast
turnaround.

## 4. What `drover grade` actually gives your CI job

Two flags matter for automation (see `drover grade --help` for the full
list):

```
drover grade <pack> --db <path> --json <path>
```

- **Exit code.** Nonzero means the Grading Run itself didn't complete — a
  malformed pack, or a genuine crash. **This is not a content-quality gate.**
  Every Case's Checks can be all failures and `drover grade` still exits 0,
  as long as the run itself completed. See §5 below — this is deliberate,
  not an oversight.
- **`--json <path>`** writes a versioned JSON summary to that path
  (`schemaVersion: 1` as of this writing) — the machine-facing artifact your
  CI job should actually parse. It preserves every Check's own name, value,
  and reasoning (never collapsed to a bare pass/fail), is self-contained
  (every referenced rubric's full definition + content hash is embedded, so
  your CI job never needs a live GraderPack just to interpret the file), and
  deliberately omits each Case's raw `input`/`output` content (a
  content-review concern for the human-facing Grading report, not this
  artifact). Consume this for automation — the human-facing markdown report
  (`--report`) is a separate, differently-versioned artifact meant for a
  person to read, not a script to parse; its shape is free to evolve for
  readability without that being a breaking change to your CI parser.
- `schemaVersion` is meant to make a future shape change your problem to
  plan for, not discover at 3am. Check it before parsing; treat an
  unrecognized version as "stop and look," not "assume it's compatible."

## 5. Fail-threshold policy: open, on purpose — don't invent one

**There is currently no built-in notion of "this Grading Run failed" beyond
"the tool itself crashed."** Whether a run's Cases/Checks are good enough to
block a merge or page someone is entirely your CI job's decision, made by
parsing the JSON summary yourself. This was deliberately left unspecified
(ADR 0005's own "Consequences and open questions" section) rather than
Drover picking a default that would silently become a de facto standard
nobody actually chose. Concretely, none of the following exist yet as a
built-in option:

- a simple count-of-hard-fails threshold,
- a percentage-based threshold,
- a layer-weighted threshold (e.g. an adversarial/Layer-7 fail weighted
  heavier than a Layer-1 fail),
- treating a *rising escalation rate* itself as an independent fail signal
  (distinct from any individual Check's outcome).

Pick whichever of these (or something else entirely) fits your team, and
implement it in your own CI script against the JSON summary's `cases[]`
array — `escalationCount`/`skipCount` per Case and `totalEscalations` for
the whole run are already there to build on. If this gets used enough to
want promoting into GraderPack config directly, that's a real follow-up
session, not something to bolt on unilaterally from the CI-wiring side.

## 6. Summary checklist

Before your first scheduled CI run:

- [ ] Self-hosted runner installed on a machine that can reach your
      judge-pool box(es) (or your pack is genuinely `synthetic-only` and
      you've deliberately chosen the cloud-runner-plus-Anthropic path).
- [ ] Thought through §2's exposure-surface question for your specific CI
      provider/network — not left as a default you never actually decided.
- [ ] Trigger is a schedule (nightly / on-merge), not a PR-blocking gate.
- [ ] CI job runs `drover grade <pack> --db <path> --json <path>` and parses
      the JSON file, not the exit code, to decide what "failed" means for
      your team.
- [ ] Your parser checks `schemaVersion` before assuming the shape it knows.
