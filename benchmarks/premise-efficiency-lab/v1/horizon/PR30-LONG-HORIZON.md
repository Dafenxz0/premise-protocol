# PR30 — long-horizon coherence measurement

Status: **measurement pass; compaction decision pending evidence review**.

This campaign runs the current runtime through reproducible horizons while
mutating a source, revalidating it, resolving a dependency frontier, testing a
conditional action conflict, rotating the source version periodically and
recording decisions. It measures active records separately from event history,
decision history, frontier tombstones, receipt state and negative-cache state.

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
preservation, absence of runtime/frontier errors, receipt-capacity accounting,
negative-cache growth and frontier-tombstone cleanup. Generated output stays
under `.tmp/`.

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

The run also includes two probes that are deliberately separate from the
main runtime decision path:

| Probe | 1,000 steps | 10,000 steps | 100,000 steps | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Unique receipt scopes | 128 entries / 872 evictions | 128 / 9,872 | 128 / 99,872 | The configured receipt cache is bounded and its evictions reconcile exactly. |
| Unique negative-cache scopes | 1,000 entries | 10,000 | 100,000 | This auxiliary cache has unbounded growth in the probe; it is not a bounded-state claim. |
| Frontier tombstones before cleanup | 16 entries | 16 | 16 | Eight roots are marked dirty, with two tombstone entries per root. |
| Frontier tombstones after leaf queries | 8 entries | 8 | 8 | Leaf resolution removes half of the tombstones. |
| Frontier tombstones after root cleanup | 0 entries | 0 | 0 | The cleanup invariant passes; associated cache entries remain separately observable. |

The repeated negative-cache entry used by the main horizon loop remains one
entry because it reuses one key. The unique-scope probe is what demonstrates
that this class of cache is not bounded by the runtime configuration. That
distinction prevents the measurement from presenting a cache eviction policy
as a general memory bound. The frontier probe likewise measures the existing
engine directly; it does not claim that the runtime event stream is compacted.

## Interpretation rule

`eventCount` and `decisionEvents` are historical state, not active memory.
If they grow linearly with the horizon while active records and frontier state
remain bounded, the result is a reason to design and separately prove safe
compaction. This run crosses that threshold, so PR31 is **required for
evaluation**. It is not permission to claim that compaction exists or that
memory usage is acceptable in production. It also does not claim that the
negative cache is bounded.
