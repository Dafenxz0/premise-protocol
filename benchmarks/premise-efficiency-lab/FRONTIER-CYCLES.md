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

Status: **MERGED; EVIDENCE CERTIFIED**.

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

## PR25 - antichain and reachability optimization

Status: **INCONCLUSIVE; NOT A CHAMPION**.

PR25 tested a candidate antichain optimization against a real compiled
champion artifact. The smoke profile was comparable and reduced primitive
work, but the medium and full profiles contained timeouts/incomplete rows.
Those rows are not treated as zero work, and the candidate was not promoted
to production or used as the next baseline. The draft PR remains evidence of
the failed/inconclusive gate rather than a performance claim.

## PR26 - incremental frontier repair

Status: **MERGED; CANDIDATE EVIDENCE PASS**.

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

## PR27 - dirty propagation locality

Status: **MERGED; CANDIDATE EVIDENCE PASS**.

PR27 targets the repeated-signal path: an equal or weaker dirty signal for a
root already represented at the same severity reuses an indexed affected
closure instead of propagating and scanning unrelated frontier cache entries.
Severity upgrades, new roots, reactivation and graph changes still take the
fully instrumented maintenance path.

The benchmark compares the candidate with the exact compiled PR26 artifact
recorded in `v1/frontier/pr27-baseline-manifest.json`; the full traversal is a
semantic oracle only. It covers repeated roots, alternating roots, unrelated
cache entries, severity escalation, reactivation, dominated roots, UNKNOWN
resolve and budget exhaustion. Every row must pass reference equivalence and
the 17-counter reconciliation before a reduction is shown.

```powershell
pnpm benchmark:efficiency:v1:frontier:propagation
node benchmarks/premise-efficiency-lab/v1/frontier/propagation.mjs --profile=medium
```

The latest smoke and medium runs pass the targeted gate. They show the
expected locality pattern (large savings when redundant signals would scan
many cached targets, smaller savings on repeated graph propagation, and no
performance claim for tokens, provider cost or external requests). The
generated report is the source of exact numbers.

## PR28 - Cycle 2: receipts, reuse and single-flight

Status: **MERGED; EXACT REUSE RUNTIME CHANGE, EVIDENCE CORRECTED BY PR29**.

PR28 compares the candidate runtime with the compiled Champion N+1 artifact
from `main` at `49f89f5`. The physical unit is validator invocations. The
candidate reuses only completed `UNCHANGED/FRESH` receipts with a complete
scope; no provider request, token, latency, RAM or cost claim is made.

The corrected smoke and medium profiles pass full-trace semantic equivalence,
independent-oracle, authorization/scope/tenant isolation, source invalidation,
expiry, failure and in-flight invalidation gates. The medium profile uses
1,000 records and reports its full counters in
[`v1/receipts/PR28-RECEIPT-REUSE.md`](./v1/receipts/PR28-RECEIPT-REUSE.md).

Partial/subsumption reuse is deliberately **not implemented**. It requires a
separate proof and adversarial campaign before it can enter a champion.

## PR29 - Cycle 3: ordered event continuity

Status: **CONTRACT HARDENING PASS; RUNTIME INTEGRATION NOT CLAIMED**.

PR29 adds fail-closed ordered snapshot/delta continuity with exact current
duplicates, gap/reorder/conflict detection, stream checks and snapshot
requirements. Its benchmark uses a separate Node oracle and proves the
legacy sorted helper would incorrectly accept several adversarial streams.
The current `V2Event` schema has no sequence metadata and
`PremiseRuntime.applyEvent` does not call this evaluator, so this PR makes no
claim of event-driven coherence, provider-request savings or performance.
Evidence and limits are documented in
[`v1/events/PR29-EVENT-CONTINUITY.md`](./v1/events/PR29-EVENT-CONTINUITY.md).

## PR30 - long horizon coherence measurement

Status: **MERGED; MEASUREMENT PASS; COMPACTION REQUIRED FOR EVALUATION**.

The current runtime was exercised for 1,000, 10,000 and 100,000 steps over an
8-record dependency chain. The independent oracle passed every row, active
records and frontier state stayed bounded, receipts stayed at one entry, and
there were no runtime/frontier errors. Historical event and decision state
grew linearly: 3,015/3,024 at 1,000 steps, 30,015/30,244 at 10,000 and
300,015/302,434 at 100,000. This is measurement evidence, not a performance
or production-memory claim.

The result requires a separate compaction evaluation. It does not mean that
compaction is implemented or safe.

## PR31 - safe state compaction

Status: **PENDING; NOT IMPLEMENTED**.

Before any implementation, PR31 must preserve ABA/incarnation semantics,
receipt replay and invalidation fences, causal evidence, idempotency replay,
snapshot/restore behavior and the full audit proof required by the runtime.

## Reproducibility

```powershell
pnpm benchmark:efficiency:v1:frontier:check
node --stack-size=65500 benchmarks/premise-efficiency-lab/v1/frontier/runner.mjs --profile=large
node benchmarks/premise-efficiency-lab/v1/frontier/report.mjs --input=.tmp/premise-efficiency-lab/v1/frontier/large.json --output=.tmp/premise-efficiency-lab/v1/frontier/large
pnpm benchmark:efficiency:v1:receipts
pnpm benchmark:efficiency:v1:events
```

Generated JSON and Markdown reports remain under `.tmp/` and are excluded
from the source change.
