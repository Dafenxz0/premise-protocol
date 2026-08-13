# PR24 - baseline and physical accounting contract

## Purpose

PR24 repairs the evidence layer before any algorithmic optimization. Every
candidate row is run against:

1. the candidate `IncrementalFrontierEngine` built from the current source;
2. the actual compiled runtime artifact recorded in `baseline-manifest.json`;
3. an independent full-traversal reference used only as a correctness oracle.

The baseline is loaded from a detached worktree at the manifest commit. Its
artifact digest is checked before the engine is imported. A label such as
`c86a6ea` is not accepted as proof of execution.

## Counter contract

Counters are emitted by the graph primitive itself and are split into
`initialization`, `maintenance` and `query` phases:

```text
graphNodeLookups
graphEdgeTraversals
reverseIndexLookups
dirtyStateReads
dirtyStateWrites
frontierLookups
frontierRootComparisons
reachabilityQueries
reachabilityNodesVisited
reachabilityEdgesTraversed
cacheLookups
cacheEntriesScanned
cacheEntriesPreserved
cacheInvalidations
cacheWrites
rootSetReads
rootSetWrites
```

`graphWork` contains graph and reachability traversal only:

```text
graphNodeLookups
+ graphEdgeTraversals
+ reachabilityNodesVisited
+ reachabilityEdgesTraversed
```

`primitiveWork` contains all listed counters. `totalWork` is maintenance plus
query work; initialization is reported separately so construction is visible
without contaminating action-time comparisons.

The runner independently checks the emitted numbers. It does not trust the
engine's summary flag alone. A row is reconciled only when all deltas are
finite non-negative integers and:

```text
cacheEntriesScanned = cacheInvalidations + cacheEntriesPreserved
physicalWork = sum(all primitive counters)
graphWork = sum(graph counters)
```

Any failed invariant makes the physical reduction unavailable.

## Frozen campaign

Cycle 1 contains six campaigns over six deterministic topologies:

- validation amplification;
- repeated dirty root;
- alternating roots;
- frontier query storm;
- multi-target overlap;
- memory pressure;
- chain, star, diamond, nested-diamond, wide and meshed graphs.

The large profile is 10,000 nodes, 20 repetitions and 1,000 target queries,
for 36 rows. The smoke profile uses the same row topology and campaign matrix
with reduced work. Seed, campaign order and topology order are recorded in the
JSON artifact.

## Claim rules

PR24 may claim only:

- the baseline artifact was verified;
- the candidate matches the independent reference;
- the candidate counters reconcile;
- the actual historical baseline's behavior, including any differences.

PR24 may not claim a physical-work reduction against `c86a6ea` because that
artifact predates the primitive counter contract. It may not claim fewer
external reads, tokens, dollars, unsafe actions or commercial savings.

The historical PR23 table remains in
`benchmarks/premise-efficiency-lab/FRONTIER-CYCLES.md` and is marked
`SUPERSEDED`.
