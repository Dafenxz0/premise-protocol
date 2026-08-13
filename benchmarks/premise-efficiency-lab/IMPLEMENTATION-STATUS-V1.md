# Efficiency Lab v1 — implementation status

This file records what has actually been executed. It is intentionally more
conservative than a roadmap.

## Executed and passing

- v1 preregistration, counter schema, oracle boundary, safety gates, benchmark
  matrix and claims policy are checked in.
- `@premise/runtime-core` emits physical counters through an optional
  best-effort observer. Observer failures cannot change decisions.
- The built runtime executes a deterministic mutable-source task runner.
- Incremental invalidation uses the opt-in frontier engine and falls back to
  the authoritative traversal when the index is incomplete or untrusted.
- The incremental affected closure is differentially checked against a
  reference traversal over deterministic DAGs.
- The minimum-work oracle distinguishes `EXACT`,
  `CERTIFIED_LOWER_BOUND`, `UNKNOWN` and `UNBOUNDED`.
- Hard safety gates are applied before the blind efficiency ranking.
- Validation-amplification, single-flight, long-horizon and receipt/cache
  attack fixtures are deterministic and recursively checked for private-field
  leakage.
- `IndependentSmart` is a separate baseline with its own TTL and volatility
  cache; it does not import PREMiSE internals.
- The candidate/oracle isolation smoke uses a child process, public-only
  NDJSON input, strict forbidden-field checks, bounded output and a
  tamper-evident hash chain.
- The sealed/local runner executes the real runtime candidate in a child
  process while the parent owns the mutation schedule, source broker and
  examiner; event-time and CAS-time mutations are covered.
- Exact-scope receipt cache, semantic fingerprints, negative cache and event
  continuity are available as opt-in experimental runtime modules.

## Commands executed by CI or a developer

```powershell
pnpm benchmark:efficiency:v1:check
pnpm benchmark:efficiency:v1:attacks
pnpm benchmark:efficiency:v1:campaign
pnpm benchmark:efficiency:v1:sealed
```

The campaign artifacts are written under `.tmp/premise-efficiency-lab/v1/`.

## Not certified yet

- The campaign runner is labelled `in-process-calibration` and suppresses its
  diagnostic ordering. The sealed/local runner proves a child-process
  candidate boundary, but the full candidate, oracle-broker and blind examiner
  campaign is not yet a sealed multi-process holdout.
- Receipt/cache optimization is opt-in and is not wired into the default
  runtime decision path.
- 100k/1M-node runs are diagnostic only.
- No external connector, LLM provider, billing, wall-clock or commercial
  efficiency claim is established by this lab.
- A passing local CI run is not an independent scientific review.

Until these items are closed, the only permitted public claim is that PREMiSE
has a reproducible physical-runtime calibration and a conservative measurement
framework—not that it is universally faster or production-ready.
