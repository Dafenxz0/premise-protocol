# Efficiency Lab frontier cycles

## Immutable comparison

All rows compare the candidate with the immediately preceding Champion from
`c86a6ea` and with an independent full-traversal reference. The candidate is
eligible only when the frontier, status and closure match the reference.

The measured unit is physical graph work:

```text
nodesVisited + edgesTraversed
```

It is not a token, provider-cost or external-request measurement.

## Cycle 1 — frontier and dirty propagation

Status: **PASS** on the deterministic large campaign.

| Campaign | Candidate work | Champion work | Reduction | Equivalence |
| --- | ---: | ---: | ---: | :---: |
| validation-amplification | 138,794 | 235,990 | 41.2% | PASS |
| repeated-dirty-root | 138,938 | 2,084,938 | 93.3% | PASS |
| alternating-roots | 254,199 | 740,220 | 65.7% | PASS |
| frontier-query-storm | 138,859 | 236,254 | 41.2% | PASS |
| multi-target-overlap | 243,505 | 4,716,904 | 94.8% | PASS |
| memory-pressure | 145,114 | 4,553,369 | 96.8% | PASS |

Campaign configuration:

- 10,000-node graphs;
- chain, star, diamond, nested-diamond, wide and meshed topologies;
- 36 rows total, fixed seed and deterministic ordering;
- independent closure/frontier/status comparison on every row;
- no safety, commercial, token or provider-cost claim.

### Accepted changes

1. Bulk initial graph construction with one iterative cycle validation pass,
   removing the accidental O(V²) bootstrap and recursive stack limit.
2. Iterative cycle validation for graph mutation.
3. One-pass restoration of persisted non-fresh states.
4. Replacement-state synchronization so a fresh replacement removes only its
   own old cause and preserves incomparable causes.
5. Correct affected-closure accounting for a new mutation, without adding
   historical dirty roots from unrelated earlier mutations.
6. Nested-diamond fixtures and generated physical-work tables.

The runtime tests include a 10,000-node chain, persisted INVALID restoration,
fresh replacement repair, the 10,000-case randomized differential suite and
the existing safety/guard tests.

## Cycle 2 — receipts, reuse and single-flight

Status: **NOT RUN in PR #23**.

The plan reserves this work for a separate champion comparison. Existing
receipt and single-flight tests remain gates, but their results must not be
presented as a Cycle 2 optimization result.

## Cycle 3 — events, long horizon and compaction

Status: **NOT RUN in PR #23**.

Event continuity, long-horizon maintenance and compaction remain separate
experiments. No result from Cycle 1 implies anything about them.

## Reproducibility

```powershell
pnpm benchmark:efficiency:v1:frontier:check
node benchmarks/premise-efficiency-lab/v1/frontier/runner.mjs --profile=large
node benchmarks/premise-efficiency-lab/v1/frontier/report.mjs --input=.tmp/premise-efficiency-lab/v1/frontier/large.json --output=.tmp/premise-efficiency-lab/v1/frontier/large
```

Generated JSON and Markdown reports remain under `.tmp/` and are excluded
from the source change.
