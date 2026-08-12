# Efficiency Lab v0 preregistration

This file freezes the evaluation rules before optimization results are
examined.

## Invariants

1. Candidate decisions must equal the reference decision for every evaluated
   scenario.
2. `unsafe_actions`, `toctou_escapes`, cross-tenant reuse and stale-receipt
   reuse must remain zero.
3. `affected_recall` must equal `1.0` whenever the oracle can calculate the
   affected set.
4. Unknown or incomplete evidence is not fresh evidence.
5. Instrumentation must not change decisions.
6. Missing denominators and unavailable measurements remain `UNKNOWN`.

## Dataset partitions

- `development`: visible to implementation agents.
- `public-adversarial`: visible for robustness testing.
- `validation`: limited use; every run is recorded.
- `sealed-holdout`: referee-only and never available to optimizers.

No implementation may be changed after seeing sealed-holdout outcomes and
then be reported against that same holdout.

## Required scenarios

- Each supported graph topology at 100, 1,000 and 10,000 nodes.
- Single, simultaneous, burst, duplicate, reordered and gapped mutations.
- Validation amplification attack.
- Shared evidence and single-flight contention.
- Long-horizon changes and late events.

The 100,000 and 1,000,000-node profiles are diagnostic stress tests. They are
not evidence that PREMiSE supports those scales in production.

## Reporting

Every report must include the commit hash, dataset hash, seed, topology,
mutation schedule, candidate identity, safety result, external work,
protocol work, p50/p95/p99 latency and each applicable Work Amplification
denominator. Partial or incomplete campaigns cannot produce a winner.
