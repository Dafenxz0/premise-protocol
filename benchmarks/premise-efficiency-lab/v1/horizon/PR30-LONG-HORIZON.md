# PR30 — long-horizon coherence measurement

Status: **measurement pass; compaction decision pending evidence review**.

This campaign runs the current runtime through reproducible horizons while
mutating a source, revalidating it, resolving a dependency frontier, testing a
conditional action conflict, rotating the source version periodically and
recording decisions. It measures active records separately from event history,
decision history, frontier tombstones and bounded receipt/negative-cache
state.

It does not add compaction and does not claim a performance improvement. The
purpose is to determine whether retained state tracks the active world or the
entire historical stream before PR31 is considered.

## Commands

Smoke gate:

```powershell
pnpm build
node --test benchmarks/premise-efficiency-lab/v1/horizon/runner.test.mjs
```

Evidence horizons (run with explicit GC for comparable heap samples):

```powershell
pnpm build
node --expose-gc benchmarks/premise-efficiency-lab/v1/horizon/runner.mjs --horizons=1000,10000,100000 --world-size=8
```

The independent oracle checks event and decision counts, active-state
preservation, absence of runtime/frontier errors and bounded receipt state.
Generated output stays under `.tmp/`.

## Clean evidence run

Node 24 with `--expose-gc`, `world-size=8`, and the three default horizons
produced:

| Horizon | Active records | Historical events | Decision events | Receipt entries | Heap sample at end |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 8 | 3,015 | 3,024 | 1 | 8.9 MiB |
| 10,000 | 8 | 30,015 | 30,244 | 1 | 30.6 MiB |
| 100,000 | 8 | 300,015 | 302,434 | 1 | 251.2 MiB |

All independent-oracle rows passed, with zero runtime/frontier errors and a
trusted frontier. The event and decision histories grow with the horizon
while active records and frontier structures stay bounded in this fixture.
The final heap sample is process heap after an explicit GC and is not a
production capacity guarantee.

## Interpretation rule

`eventCount` and `decisionEvents` are historical state, not active memory.
If they grow linearly with the horizon while active records and frontier state
remain bounded, the result is a reason to design and separately prove safe
compaction. This run crosses that threshold, so PR31 is **required for
evaluation**. It is not permission to claim that compaction exists or that
memory usage is acceptable in production.
