# PREMiSE Efficiency Lab v1 preregistration

This document freezes the scientific contract for Efficiency Lab v1 before
the v1 holdout is opened. The historical v0 calibration remains available
under the `premise-efficiency-lab/0` format and is not silently relabelled.

## Objective

Measure physical work performed by a real PREMiSE runtime while preserving
the normative decisions of `premise/1.1` and the safety constraints of
`premise-guard/1` and `premise-policy/1`.

The primary hypothesis is:

> When the relevant change remains small, an incremental PREMiSE runtime does
> work proportional to the relevant blast radius rather than the complete
> memory graph.

This is an algorithmic hypothesis. It is not a production availability,
provider-cost, LLM or commercial claim.

## Frozen dimensions

Before any candidate is evaluated against a holdout, the campaign freezes:

- repository commit;
- Node and pnpm versions;
- candidate list and public order;
- graph topology and node-count matrix;
- mutation schedules and event capabilities;
- seeds and task counts;
- counter schema and counting rules;
- oracle version and certificate mode;
- hard safety gates;
- ranking rules;
- exclusion rules;
- artifact paths and retention policy.

Changing one of these after seeing holdout output creates a new campaign and
requires a new manifest. It cannot be reported as a continuation of the old
campaign.

## Partitions

| Partition | Optimizer access | Purpose |
| --- | --- | --- |
| development | allowed | implementation and debugging |
| public-adversarial | allowed | reproducible attack regression |
| validation | recorded, limited | pre-holdout selection |
| sealed-holdout | referee only | final unbiased comparison |

The 100k and 1m profiles are diagnostic stress runs until their memory,
runtime and oracle certificates have passed the same gates as smaller runs.

## Candidate contract

The official v1 candidate must execute the real `@premise/runtime-core`
implementation through an instrumented adapter. The old policy simulator is
retained as `MODEL_ONLY` calibration and cannot enter the v1 winner ranking.

Every candidate receives only public observations, delivered events, declared
capabilities, risk and allowed operations. Mutation truth, affected sets,
expected decisions and candidate mappings are evaluator-only data.

## Required scenario families

- chain, star, diamond, deep DAG, wide DAG and meshed DAG;
- 100, 1,000 and 10,000 nodes as required profiles;
- 100,000 and 1,000,000 nodes as diagnostic profiles;
- isolated, simultaneous, burst, duplicate, reordered, gapped and late events;
- validation amplification;
- shared evidence and single-flight contention;
- long-horizon drift;
- delete/recreate and ABA identity changes;
- authorization, tenant, query and causal-frontier changes;
- CAS conflicts, leases and fencing;
- stale receipt replay and cache poisoning.

## Primary metrics

Safety is evaluated before efficiency. Eligible candidates expose:

- safe completions;
- unsafe actions;
- false blocks;
- affected recall;
- TOCTOU escapes;
- stale-receipt reuse;
- cross-tenant reuse;
- `UNKNOWN` promoted to `FRESH`;
- reference equivalence.

Physical work is recorded independently:

- external reads, requests and writes;
- nodes visited and edges traversed;
- frontier visits and recomputations;
- index lookups and dirty propagations;
- receipt hits and misses;
- single-flight leaders and joins;
- event continuity checks;
- CAS attempts and conflicts;
- batches and batch items;
- compaction work.

For each dimension:

```text
WA = actual physical work / certified minimum work
```

If the denominator is zero, unavailable or not certified, the result is
`UNKNOWN` or `UNBOUNDED` according to the metric contract. It is never
replaced with an invented one-operation minimum.

## Campaign acceptance

The referee may rank a candidate only if every hard gate in
`SAFETY-GATES.md` passes. A candidate that blocks all actions is not an
efficient candidate and cannot win through a low work denominator.

Reports must include the commit hash, dataset hash, seed, oracle certificate
mode, candidate ID, raw counters, safety gates and claims boundary.
