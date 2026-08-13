# PR25 - antichain reachability candidate

## Hypothesis

The champion antichain implementation performs graph reachability correctly,
but repeats the same `(start, target)` reachability walk for every affected
node that receives the same dirty-root set. Root explosion makes this visible:
100 roots in a 1,000-node nested-diamond graph produced repeated reachability
work in the hundreds of millions of primitive operations before PR25.

PR25 evaluates candidate B from the roadmap: a deterministic reachability
cache scoped to the current graph revision. It changes no PREMiSE decision
semantics and stores only boolean graph facts; it is invalidated on every
graph mutation.

## New accounting

The physical counter contract is extended with:

```text
reachabilityCacheLookups
reachabilityCacheHits
reachabilityCacheMisses
reachabilityCacheWrites
reachabilityCacheEvictions
reachabilityCacheEntriesCleared
```

The cache is bounded at 65,536 entries with FIFO eviction. The cache key is a
structured JSON pair, so protocol IDs containing delimiters or NUL characters
cannot alias one another. The benchmark reports the limit and eviction count;
an unbounded cache is not an acceptable implementation.

The frontier reducer also has a 5,000,000 root-comparison budget per
maintenance operation. If the budget is exhausted, the engine returns
`UNKNOWN` with `complete:false` instead of spending unbounded CPU or exposing
a partial frontier as safe evidence. Such a row is `INCONCLUSIVE` in the
benchmark.

Logical `reachabilityQueries` remains visible for every request. Only cache
misses traverse the graph and increment `reachabilityNodesVisited` and
`reachabilityEdgesTraversed`. Cache reads and writes remain in `primitiveWork`
so the optimization cannot make work disappear from the report.

## Adversarial matrix

The PR25 runner covers deterministic root-explosion fixtures with:

- dirty-root counts 100, 500, 1,000, 10,000 and 50,000, depending on profile;
- nested-diamond, meshed, reconvergent and wide DAGs;
- repeated overlapping roots and root-order permutations;
- CPU time, resident-memory before/after, logical queries, cache hits/misses,
  evictions and physical work;
- exact candidate/champion frontier/status/closure comparisons for paired rows;
  an independent full-traversal reference for candidate rows up to 128 roots.

The 10,000/50,000-root profile is diagnostic unless it completes within the
explicit resource budget. Diagnostic rows run the candidate first and may
leave the champion as `NOT_RUN` after a fail-closed candidate result; this is
`INCONCLUSIVE`, never a win. A timeout, OOM or incomplete row is also
`INCONCLUSIVE`, never a win.

## Executed result

The smoke gate passed: 16/16 comparable rows, with zero candidate failures,
timeouts, incomplete rows, accounting failures or reference mismatches. Its
median physical-work reduction was 56.8% on that small fixture.

The medium diagnostic completed 24 rows, of which 14 were comparable. Four
candidate rows were incomplete, eight champion rows timed out and two champion
rows were not run; ten rows were therefore `INCONCLUSIVE`. The 14.7% median
reduction is descriptive of the 14 comparable rows only. The full diagnostic
completed 48 rows, with 17 comparable rows, 21 candidate timeouts, 8 other
candidate-incomplete rows, 2 champion timeouts and 29 champion-not-run rows;
31 rows were `INCONCLUSIVE`. At 10,000/50,000 roots the champion is omitted by
design as a candidate-first diagnostic, even if the candidate completes. The
14.7% median reduction is descriptive of the comparable subset only. No
medium/full result replaces the champion or supports a production-scale
performance claim.

## Acceptance gates

The cached candidate can replace the champion only if:

- all deterministic equivalence tests pass;
- affected recall is exact;
- unsafe actions, stale reuse, TOCTOU escapes, unknown-to-fresh promotion and
  cross-tenant reuse remain zero;
- safe completion is no worse and false blocks are no higher;
- accounting reconciles, including reachability-cache work;
- the benchmark reports a measurable improvement on the root-explosion
  workload or a proven better asymptotic bound;
- no old PR23 reduction is used as the denominator.

If any gate fails, the cache candidate is rejected and the branch documents
the negative result without merging an optimization.
