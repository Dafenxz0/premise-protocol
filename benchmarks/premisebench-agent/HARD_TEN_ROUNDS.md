# Hard ten-round campaign

`hard-ten-rounds.mjs` is the internal stress campaign for PREMiSE. It combines the controls accumulated during the project: mutable evidence, CAS/TOCTOU, event races, dependencies, large payloads, risk tiers, volatility, safety, connector I/O, visible-payload accounting and a separated real-provider harness.

## Frozen schedule

The deterministic cohort has ten rounds with 2,500 paired tasks in total:

`200, 200, 225, 225, 250, 250, 275, 275, 300, 300`

Volatility rises from 25% to 100%. The same task is presented to every deterministic arm in a round. The examiner sees anonymous candidate IDs; the identity mapping remains evaluator-only.

## Arms and metrics

- `basic`: initial memory and unguarded action.
- `conventional`: source read followed by an unguarded action.
- `smart`: local probe, conditional read and CAS retry.
- `always`: read before every action and CAS retry.
- `premise`: PREMiSE local freshness check, conditional read and CAS.
- `perfect`: deterministic diagnostic ceiling, not a product competitor.

The report prints both numerators and denominators. `Safe completion` is tasks; `Unsafe actions` is action attempts. Requests, reads, writes, local checks, visible payload tokens, synthetic proxy cost and recovery are kept separate. Provider tokens and provider billing remain `UNKNOWN` unless the provider supplies trustworthy telemetry.

## Run locally

Offline smoke/check:

```text
pnpm benchmark:hard:check
```

Full deterministic campaign plus a guarded Gemini sample:

```text
pnpm benchmark:hard:ten
```

The live sample is deliberately opt-in and stops after a provider rate limit. An incomplete provider campaign is recorded as `RATE_LIMITED`, `NOT_RUN`, or `COMPLETE_WITH_GAPS`; it never produces a ranking or zero-filled cost.

Generated reports live under `.tmp/scientific-mvp/` and are ignored by Git. The deterministic campaign is a local simulation of filesystem-, Git-, PostgreSQL- and calendar-like worlds, not evidence from live connectors. The live LLM harness is evidence of adapter wiring and behavior only when its complete cohort, holdout and billing telemetry are available.

## Tuning rule

The protocol is not changed merely to lower a request count on the same dataset. A proposed optimization must preserve CAS and freshness safety, pass the hard regression vectors, and improve a later frozen holdout. If PREMiSE is already on the safe-efficiency frontier, the correct outcome is `NO_UNSAFE_CHANGE_JUSTIFIED`.
