# Efficiency Lab frontier cycles

## Evidence status

The Cycle 1 table below is a **historical PR23 report and is SUPERSEDED**.
It compared against a reconstructed champion and counted only the legacy
`nodesVisited + edgesTraversed` fields. It must not be used as a current
performance claim.

PR24 reran the same deterministic fixture against the actual compiled
artifact at commit `c86a6eaeb80107e3aa41d1a6c76c0025ec2477e` and emitted the
new primitive counter contract. It was merged as commit
`56f380307f4eada9f5bb5223e0fe739f76f0a862`. The baseline remains immutable;
PR25 uses it as the champion and does not reuse the historical PR23
denominator.

For PR24, `status: PASS` means the frozen six-campaign validation rerun,
candidate/reference equivalence and accounting gates passed. The report also
publishes `baselineComparisonStatus`; it is `INCONCLUSIVE` for the known
alternating-root baseline differences. That status blocks any candidate versus
champion performance claim even though the integrity rerun itself is green.

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

Status: **COMPLETE and MERGED**.

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

## PR25 - causal antichain under root explosion

Status: **CANDIDATE IMPLEMENTED; SMOKE PASS; MEDIUM/FULL INCONCLUSIVE**.

PR25 adds a graph-revision-scoped boolean reachability fallback and a causal
antichain reducer to the current frontier engine. Once propagation has
materialized direct-root ancestry, Candidate C uses that exact relation instead
of repeating BFS for every antichain comparison. The cache is invalidated on
graph mutation, and cache reads, writes, hits and misses remain counted as
physical primitive work. Root-set work, fallback reachability work and the
active-root-state limit are also counted; the decision, frontier and affected
closure remain unchanged.

The smoke campaign ran 16 isolated candidate/champion pairs across nested
diamonds, meshed DAGs, reconvergent DAGs and wide DAGs at 16, 32, 64 and 128
dirty roots. All 16 pairs matched the champion and the independent oracle;
candidate accounting reconciled in every case. Candidate C's observed median
physical-work reduction was 96.58% for this smoke fixture only. It is not a
commercial, safety or universal-scale claim.

The immutable PR24 champion predates the six PR25 reachability-cache
counters. The runner explicitly records those absent fields and defaults them
to zero only for that known no-cache champion; any other missing counter makes
the comparison inconclusive. This normalization is visible in every worker
row and is not an unreported denominator change. Medium adds forward/reverse
root order; full adds an interleaved order.

The candidate bounds the reachability cache at 65,536 entries, caps each
maintenance operation at 5,000,000 frontier-root relation checks, fallback
reachability work units and active causal-root entries. Exceeding any budget returns
`UNKNOWN`/`complete:false` and is reported as `INCONCLUSIVE`, never as a safe
completion or optimization win.

The executed diagnostics are recorded here so an incomplete campaign cannot be
mistaken for a win:

| Profile | Cases | Comparable | Candidate timeouts | Candidate incomplete | Champion timeouts | Champion not run | Status | Median physical reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: | ---: |
| smoke | 16 | 16 | 0 | 0 | 0 | 0 | PASS | 96.6% |
| medium | 24 | 14 | 2 | 0 | 8 | 2 | INCONCLUSIVE | 94.8%* |
| full | 48 | 17 | 16 | 10 | 5 | 26 | INCONCLUSIVE | 94.8%* |

`*` The status columns are row counts and can overlap because a row may have an
incomplete candidate and an unavailable champion. The medium percentage
describes only comparable PASS rows; it is not a campaign-wide or production
claim. Full rows at 10,000/50,000 roots are candidate-first diagnostics and
the champion is intentionally not run at that scale, even when the candidate
completes; no pairwise reduction is inferred for those rows.

```powershell
pnpm benchmark:efficiency:v1:frontier:root-explosion:check
node benchmarks/premise-efficiency-lab/v1/frontier/root-explosion.mjs --profile=medium
node benchmarks/premise-efficiency-lab/v1/frontier/root-explosion.mjs --profile=full
```

The medium profile uses 100, 500 and 1,000 roots with forward/reverse order;
the full profile uses 100, 1,000, 10,000 and 50,000 roots with forward,
reverse and interleaved order. A champion timeout, OOM or incomplete row is
`INCONCLUSIVE`; it never becomes an optimization win. The worker currently
records RSS before and after each isolated process; peak-memory sampling
remains a separate gate.

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
