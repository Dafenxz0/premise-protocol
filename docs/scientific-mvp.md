# PREMiSE Scientific MVP

Scientific MVP is the first evidence gate for the hypothesis that PREMiSE manages coherence work more efficiently than ordinary memory when an environment changes.

It is deliberately narrower than the production or GA work. It does not add a database, embeddings, retrieval, a cloud service or a new protocol version.

## What is being measured

The headline number is cost per successful fresh action, not raw request count:

```text
CSFA = total measured agent cost / correct actions completed with fresh evidence
```

The report also separates safe attempts from safe successful tasks so that a policy cannot appear efficient merely by refusing to act.

The deterministic run uses a declared payload proxy. Real LLM campaigns use provider usage and billing fields when the provider exposes them. Missing usage is `UNKNOWN` or `NOT_RUN`, never zero.

## Scientific controls

The comparison contains basic memory, conventional revalidation, a capable Smart Revalidate baseline, strong Always Revalidate, PREMiSE and a deterministic perfect-agent control. An Ideal Oracle Revalidator is calculated only after execution as a theoretical lower-bound reference.

The agent process cannot receive mutation labels, expected outcomes, oracle fields or holdout metadata. Candidate IDs are anonymized before the examiner ranks them.

## Current status

The deterministic harness and mutation campaigns are local evidence. They do not prove a provider-level LLM cost reduction. Real provider campaigns are eligible for publication only when their model ID, prompt hash, token usage, tariff snapshot, raw traces and independent blind evaluation are present.

The first release gate is Scientific MVP. If PREMiSE does not beat a capability-matched Smart baseline at comparable safety on the sealed holdout, the project stops at `LIMITED` and the result is reported as such.

## Development matrix

The runner also executes a local matrix over volatility `0%, 1%, 5%, 10%,
25%, 50%` and risk tiers `low, medium, high, critical`. The matrix is a
development and sensitivity instrument: it reports strata and a safety-cost
curve, but it is not a sealed holdout, an external domain result, or provider
billing. Run it with:

```text
pnpm benchmark:scientific:matrix
```

The generated report is kept under `.tmp/scientific-mvp/matrix/<round>/` and
includes anonymous candidate input, a separately launched blind examiner,
private mapping, per-cell tables and the task-set hash.

## Deterministic holdout control

After a release candidate is frozen, a private explicit seed can run the
deterministic holdout control exactly once:

```text
node benchmarks/premisebench-agent/scientific/runner.mjs --tasks=200 --seed=<private-seed> --round=scientific-mvp-holdout-rc1 --holdout=true
node scripts/premisebench-agent/scientific-self-check.mjs --round=scientific-mvp-holdout-rc1
```

The runner rejects a holdout without an explicit seed or a round name
containing `holdout`. This protects against accidentally treating the normal
development run as the final evaluation. It remains a deterministic local
control; an independent custodian, hidden dataset and signed attestation are
still required for an external holdout claim.

## Real-provider pilot status

A real Gemini `gemini-3.5-flash-lite` pilot completed end to end with JSON
responses, token counts, latency, private mutation state, anonymous candidates
and a blind examiner. In the corrected two-task smoke campaign, PREMiSE and
Smart completed 2/2 tasks safely; the basic and conventional arms completed 1/2
each. This is a wiring/compliance observation only: `n=2`, provider billing was
not returned, and it is not a commercial or statistical claim.

A five-task attempt is retained as `ERROR` because one conventional arm hit
HTTP 429. The run is not ranked and its missing telemetry is not filled with
zero. This is intentional evidence that quota and provider failures are part of
the experiment, not successes.

The live provider command is opt-in and can be throttled explicitly:

```text
pnpm benchmark:llm:pilot
```

For a publishable comparison, use the full preregistered cohort, at least two
model families, a frozen tariff or provider invoice, and a sealed holdout.

## Reproduction

Use Node 24 and pnpm 10:

```text
pnpm benchmark:scientific:mvp
pnpm benchmark:scientific:check
```

Generated reports and raw traces live outside Git under the benchmark artifact directory or `.tmp/scientific-mvp`. The repository stores the runner, contracts and methodology, not generated evidence pretending to be source code.
