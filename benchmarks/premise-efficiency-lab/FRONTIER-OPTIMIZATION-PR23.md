# PR #23 — Incremental frontier efficiency campaign

PR #22 (`c86a6ea`) is the immutable Efficiency Lab v1 baseline. This PR is
limited to graph frontier computation, dirty propagation, cache preservation
and antichain maintenance. Receipts, event semantics, compaction and provider
cost are explicitly out of scope.

## Acceptance gate

An optimization can become the next champion only when it has:

```text
referenceEquivalent = PASS
affectedRecall       = 1.0
unsafeActions        = 0
TOCTOU escapes       = 0
stale reuse          = 0
cross-tenant reuse   = 0
unknown -> fresh     = 0
safe completion      >= champion
false blocks         <= champion
```

and either:

```text
>= 20% less graph work
or >= 15% less validation/external work
or a proven better worst-case complexity.
```

The candidate is compared against the immediately preceding champion, never
against an older weaker implementation.

## Frozen work model

Mutation-time index and dirty propagation work is `maintenanceWork`. Frontier
queries and action preparation after the mutation are `queryWork`.

```text
WA_query        = query work / certified query minimum
WA_maintenance  = maintenance work / certified maintenance minimum
WA_total        = (query + maintenance) / certified total minimum
```

No ratio is claimed when the denominator is not certified. The campaign still
reports physical counters and locality ratios without inventing a denominator.

## Cycle 1 scope

- incremental dirty propagation;
- severity-aware dirty generations;
- targeted frontier-cache invalidation;
- maintained causal roots and antichain compression;
- iterative bulk graph bootstrap and cycle validation for deep graphs;
- runtime restoration of persisted frontier states and replacement-state repair;
- differential closure/frontier/status testing.

Cycle 2 is reserved for receipt reuse and single-flight. Cycle 3 is reserved
for event processing, long-horizon maintenance and compaction. Neither may be
silently folded into this PR.

## Reproducible command

```powershell
pnpm benchmark:efficiency:v1:frontier:check
```

The runner writes reports only under `.tmp/premise-efficiency-lab/v1/frontier/`
and labels 100k/1m profiles as diagnostic until memory and independent
holdout gates are provisioned.

The public smoke gate also emits `report.md` and `summary.json`. These files
contain physical graph-work comparisons only; they do not claim lower token
usage, provider cost, external reads or commercial savings.
