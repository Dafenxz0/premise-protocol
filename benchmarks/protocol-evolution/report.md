# PREMiSE protocol-evolution benchmark

Format: **premise-protocol-evolution-benchmark/1**<br>
Mode: **offline-deterministic**<br>
Seed: **premise-protocol-evolution-v1**<br>
Cases: **13** across **5** scenarios

## What this measures

The benchmark is an offline, deterministic comparison of simple baselines and
reference policies for identity ABA, scoped invalidation, receipt sharing and
single-flight, causal coherence, and guard TOCTOU.

Safety is an outcome property: a baseline is marked unsafe when it permits an
operation that violates the scenario invariant. The reference rows must have
zero unsafe outcomes. Physical work is reported as integer counts of simulated
operations. It is not converted into time, money, energy, capacity, or provider
billing.

Execution uses no network, clock, randomness, external dependency, or mutable
external state. Run it with:

```text
node benchmarks/protocol-evolution/runner.mjs
node benchmarks/protocol-evolution/self-check.mjs
```

Reference rows: **0 unsafe outcomes**
across 5 rows (100% safe).
Baseline rows: **4 unsafe outcomes**
across 6 rows (76.47% safe).

## Identity and ABA

Can a receipt survive delete/recreate or cross-tenant identity reuse?

| Strategy | Baseline | Safety | Physical work | Case outcomes |
|---|:---:|---|---|---|
| tenant-resource-version | yes | 2/3 safe; 1 unsafe; 0 unsafe effects | reads=3, validations=3, guard=0, CAS=0, commits=0, effects=0, invalidations=0, revalidations=0, shared hits=0, snapshots=0, total=6 | unchanged-observation:safe; aba-delete-recreate:UNSAFE; cross-tenant-replay:safe |
| full-identity | no | 3/3 safe; 0 unsafe; 0 unsafe effects | reads=3, validations=3, guard=0, CAS=0, commits=0, effects=0, invalidations=0, revalidations=0, shared hits=0, snapshots=0, total=6 | unchanged-observation:safe; aba-delete-recreate:safe; cross-tenant-replay:safe |

## Scoped invalidation

Does an unrelated scope preserve reuse while a dependent scope forces revalidation?

| Strategy | Baseline | Safety | Physical work | Case outcomes |
|---|:---:|---|---|---|
| resource-wide-invalidation | yes | 2/2 safe; 0 unsafe; 0 unsafe effects | reads=2, validations=2, guard=0, CAS=0, commits=0, effects=0, invalidations=2, revalidations=2, shared hits=0, snapshots=0, total=8 | unrelated-metadata-change:safe; dependent-head-change:safe |
| scope-aware-invalidation | no | 2/2 safe; 0 unsafe; 0 unsafe effects | reads=1, validations=2, guard=0, CAS=0, commits=0, effects=0, invalidations=1, revalidations=1, shared hits=0, snapshots=0, total=5 | unrelated-metadata-change:safe; dependent-head-change:safe |

## Receipt sharing and single-flight

Can concurrent work share a receipt without crossing scope, policy or frontier boundaries?

| Strategy | Baseline | Safety | Physical work | Case outcomes |
|---|:---:|---|---|---|
| no-sharing | yes | 4/4 safe; 0 unsafe; 0 unsafe effects | reads=4, validations=4, guard=0, CAS=0, commits=0, effects=0, invalidations=0, revalidations=0, shared hits=0, snapshots=0, total=8 | request-a1:safe; request-a2:safe; request-a3:safe; request-b1:safe |
| resource-only-sharing | yes | 3/4 safe; 1 unsafe; 0 unsafe effects | reads=1, validations=1, guard=0, CAS=0, commits=0, effects=0, invalidations=0, revalidations=0, shared hits=3, snapshots=0, total=5 | request-a1:safe; request-a2:safe; request-a3:safe; request-b1:UNSAFE |
| exact-key-single-flight | no | 4/4 safe; 0 unsafe; 0 unsafe effects | reads=2, validations=2, guard=0, CAS=0, commits=0, effects=0, invalidations=0, revalidations=0, shared hits=2, snapshots=0, total=6 | request-a1:safe; request-a2:safe; request-a3:safe; request-b1:safe |

## Causal coherence

Does a multi-member read reject mixed event heads or bind all members to one snapshot?

| Strategy | Baseline | Safety | Physical work | Case outcomes |
|---|:---:|---|---|---|
| naive-member-reads | yes | 1/2 safe; 1 unsafe; 0 unsafe effects | reads=4, validations=2, guard=0, CAS=0, commits=0, effects=0, invalidations=0, revalidations=0, shared hits=0, snapshots=0, total=6 | stable-members:safe; mutation-between-members:UNSAFE |
| transactional-snapshot | no | 2/2 safe; 0 unsafe; 0 unsafe effects | reads=0, validations=2, guard=0, CAS=0, commits=0, effects=0, invalidations=0, revalidations=0, shared hits=0, snapshots=2, total=4 | stable-members:safe; mutation-between-members:safe |

## Guard TOCTOU

Does a mutation after validation cause an effect, or does conditional commit fail closed?

| Strategy | Baseline | Safety | Physical work | Case outcomes |
|---|:---:|---|---|---|
| read-then-write | yes | 1/2 safe; 1 unsafe; 1 unsafe effects | reads=2, validations=0, guard=2, CAS=0, commits=2, effects=2, invalidations=0, revalidations=0, shared hits=0, snapshots=0, total=8 | unchanged-before-commit:safe; mutation-after-validation:UNSAFE |
| conditional-CAS | no | 2/2 safe; 0 unsafe; 0 unsafe effects | reads=2, validations=0, guard=2, CAS=2, commits=2, effects=1, invalidations=0, revalidations=0, shared hits=0, snapshots=0, total=9 | unchanged-before-commit:safe; mutation-after-validation:safe |

## Reading the result

- `sourceReads`, `validationCalls`, `guardChecks`, `conditionalChecks`,
  `commits`, `effects`, `invalidations`, `revalidations`, `sharedHits`, and
  `snapshotReads` are physical operation counts from this model.
- `total` is their sum, with no weighting and no monetary interpretation.
- A safe row may still do more work (for example, wide invalidation); safety is
  evaluated before work is compared.

## Limits

This benchmark proves only that the deterministic scenarios distinguish the
declared policies under the modeled events. It does not measure production
latency, durability, throughput, hardware, cloud billing, or the truth of an
external source.
