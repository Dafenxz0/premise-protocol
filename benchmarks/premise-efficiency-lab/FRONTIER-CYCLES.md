# Efficiency Lab frontier cycles

## Evidence status

The Cycle 1 table below is a **historical PR23 report and is SUPERSEDED**.
It compared against a reconstructed champion and counted only the legacy
`nodesVisited + edgesTraversed` fields. It must not be used as a current
performance claim.

PR24 reruns the same deterministic fixture against the actual compiled
artifact at commit `c86a6eaeb80107e3aa41d1a6c76c0025ec2477e` and emits the new
primitive counter contract. The current report deliberately exposes both
quantities without dividing them: the old artifact has no physical primitive
counters, so a physical-work reduction is **not certified** yet.

## Immutable comparison

All current rows compare the candidate and the actual baseline with an
independent full-traversal reference. The candidate is eligible only when the
frontier, status and closure match the reference. A mismatch from the actual
historical artifact is retained as an observed baseline difference.

The historical measured unit was physical graph work:

```text
nodesVisited + edgesTraversed
```

It is not a token, provider-cost or external-request measurement.

## Historical Cycle 1 (PR23) - frontier and dirty propagation

Status: **SUPERSEDED**. The table is preserved for provenance only.

| Campaign | Candidate work | Champion work | Reduction | Equivalence |
| --- | ---: | ---: | ---: | :---: |
| validation-amplification | 138,794 | 235,990 | 41.2% | PASS |
| repeated-dirty-root | 138,938 | 2,084,938 | 93.3% | PASS |
| alternating-roots | 254,199 | 740,220 | 65.7% | PASS |
| frontier-query-storm | 138,859 | 236,254 | 41.2% | PASS |
| multi-target-overlap | 243,505 | 4,716,904 | 94.8% | PASS |
| memory-pressure | 145,114 | 4,553,369 | 96.8% | PASS |

The historical campaign used 10,000-node graphs, six topologies and 36 rows.
Its results remain useful only as a record of what was previously published.

## PR24 certification rerun - baseline and accounting

Status: **IN PROGRESS** until the exact frozen large campaign is executed and
reviewed.

The gate requires:

- baseline artifact digest verified from the manifest;
- 36 rows from the same six campaigns and six topologies;
- candidate/reference equivalence on every row;
- independent reconciliation of every primitive counter and cache scan;
- no performance percentage when the baseline counter contract is absent;
- no safety or commercial claim.

The smoke command is:

```powershell
pnpm benchmark:efficiency:v1:frontier:check
```

The large command must use the larger Node stack because the historical
baseline is intentionally executed as-is:

```powershell
node --stack-size=65500 benchmarks/premise-efficiency-lab/v1/frontier/runner.mjs --profile=large
node benchmarks/premise-efficiency-lab/v1/frontier/report.mjs --input=.tmp/premise-efficiency-lab/v1/frontier/large.json --output=.tmp/premise-efficiency-lab/v1/frontier/large
```

## PR26 - incremental frontier repair

Status: **IMPLEMENTED LOCALLY; CANDIDATE EVIDENCE PASS**.

PR26 evaluates lazy root removal and query-paid tombstone cleanup. It is
compared to an independent full traversal, not promoted to a champion by a
modelled closure size. The acceptance evidence is in
[`v1/frontier/PR26-INCREMENTAL-RESOLVE.md`](./v1/frontier/PR26-INCREMENTAL-RESOLVE.md).

```powershell
pnpm benchmark:efficiency:v1:frontier:resolve
```

The campaign covers chain, fan-out and reconvergent graphs, resolving one of
two active roots, resolving a derived/non-root node, reactivating a resolved
root, complete snapshot validation and an UNKNOWN root. It reports
`resolveMaintenanceWork`, total physical work, tombstone entries and the
eager closure only as a diagnostic. It has no performance percentage claim.

The budget is a safety bound. If root-state or reachability work exceeds it,
the engine invalidates its trust and returns an incomplete UNKNOWN result.
That outcome is a safety failure/inconclusive run, never a win.

## Cycle 2 - receipts, reuse and single-flight

Status: **NOT RUN in PR24**.

The plan reserves this work for a separate champion comparison. Existing
receipt and single-flight tests remain gates, but their results must not be
presented as a Cycle 2 optimization result.

## Cycle 3 - events, long horizon and compaction

Status: **NOT RUN in PR24**.

Event continuity, long-horizon maintenance and compaction remain separate
experiments. No result from the evidence rerun implies anything about them.

## Reproducibility

```powershell
pnpm benchmark:efficiency:v1:frontier:check
node --stack-size=65500 benchmarks/premise-efficiency-lab/v1/frontier/runner.mjs --profile=large
node benchmarks/premise-efficiency-lab/v1/frontier/report.mjs --input=.tmp/premise-efficiency-lab/v1/frontier/large.json --output=.tmp/premise-efficiency-lab/v1/frontier/large
```

Generated JSON and Markdown reports remain under `.tmp/` and are excluded
from the source change.
