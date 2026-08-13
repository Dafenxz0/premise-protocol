# PR25 - causal antichain and bounded reachability candidate

## Hypothesis

The champion antichain implementation performs graph reachability correctly,
but repeats the same `(start, target)` reachability walk for every affected
node that receives the same dirty-root set. Root explosion makes this visible:
100 roots in a 1,000-node nested-diamond graph produced repeated reachability
work in the hundreds of millions of primitive operations before PR25.

PR25 first evaluates candidate B, a deterministic reachability cache scoped to
the current graph revision, and then adds candidate C: after propagation has
materialized which direct dirty roots reach each direct root, the antichain is
reduced from those causal relations instead of repeating BFS for every target.
Candidate C changes no PREMiSE decision semantics. The cache remains a bounded
fallback for cases where the causal relation is unavailable; it is invalidated
on every graph mutation.

## New accounting

The physical counter contract is extended with:

```text
reachabilityCacheLookups
reachabilityCacheHits
reachabilityCacheMisses
reachabilityCacheWrites
reachabilityCacheWriteSkips
reachabilityCacheEvictions
reachabilityCacheEntriesCleared
```

The cache is bounded at 65,536 entries with FIFO eviction. The cache key is a
structured JSON pair, so protocol IDs containing delimiters or NUL characters
cannot alias one another. The benchmark reports the limit and eviction count;
an unbounded cache is not an acceptable implementation.

Candidate C also reports and bounds `activeRootStateEntries`, and bounds the
physical node/edge work of the legacy reachability fallback. If the causal
root state or fallback work would exceed its 5,000,000-entry/work budget, the engine returns
`UNKNOWN`/`complete:false` and the benchmark records `INCONCLUSIVE` before the
process is allowed to grow without bound.

The frontier reducer also has a 5,000,000 root-comparison budget per
maintenance operation. If the budget is exhausted, the engine returns
`UNKNOWN` with `complete:false` instead of spending unbounded CPU or exposing
a partial frontier as safe evidence. Such a row is `INCONCLUSIVE` in the
benchmark.

Logical `reachabilityQueries` remains visible for every request. Candidate C
normally reaches zero BFS queries on the root-explosion workload because the
causal-root relation is already materialized by propagation. Root-set reads,
writes and frontier relation checks remain in `primitiveWork`; the optimization
cannot make work disappear from the report.

## Adversarial matrix

The PR25 runner covers deterministic root-explosion fixtures with:

- dirty-root counts 100, 500, 1,000, 10,000 and 50,000, depending on profile;
- nested-diamond, meshed, reconvergent and wide DAGs;
- repeated overlapping roots and root-order permutations;
- CPU time, resident-memory before/after, logical queries, cache hits/misses,
  evictions, active-root-state entries and physical work;
- exact candidate/champion frontier/status/closure comparisons for paired rows;
  an independent full-traversal reference for candidate rows up to 128 roots.

The 10,000/50,000-root profile is diagnostic unless it completes within the
explicit resource budget. Diagnostic rows run the candidate first and may
leave the champion as `NOT_RUN` after a fail-closed candidate result; this is
`INCONCLUSIVE`, never a win. A timeout, OOM or incomplete row is also
`INCONCLUSIVE`, never a win.

## Executed result

The strict smoke gate passed: 16/16 comparable rows, with zero candidate
failures, timeouts, incomplete rows, accounting failures or reference
mismatches. Candidate C's median physical-work reduction was 96.58% on that
small fixture. This is a fixture-local result, not a universal-scale claim.

The strict medium diagnostic completed 24 rows, of which 14 were comparable.
Two candidate rows timed out, eight champion rows timed out and two rows were
not run after a candidate timeout; ten rows were therefore `INCONCLUSIVE`. The
94.84% median reduction describes only the 14 comparable rows. Full must be
rerun from a clean, provenance-verified candidate artifact after this commit;
its previous pre-provenance output is not evidence for this revision. No
medium/full result replaces the champion or supports a production-scale
performance claim.

## Acceptance gates

The causal antichain candidate can replace the champion only if:

- all deterministic equivalence tests pass;
- affected recall is exact;
- unsafe actions, stale reuse, TOCTOU escapes, unknown-to-fresh promotion and
  cross-tenant reuse remain zero;
- safe completion is no worse and false blocks are no higher;
- accounting reconciles, including root-set, causal-relation and fallback
  reachability work;
- the benchmark reports a measurable improvement on the root-explosion
  workload or a proven better asymptotic bound;
- no old PR23 reduction is used as the denominator.

If any gate fails, the candidate is rejected and the branch documents the
negative result without merging an optimization.
