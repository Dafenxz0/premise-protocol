# PR #23 - Incremental frontier efficiency campaign (historical)

> **SUPERSEDED by PR24 evidence work.** The implementation and table remain
> for provenance, but their reconstructed-champion reductions are not current
> certified results.

PR #22 (`c86a6ea`) was the immutable Efficiency Lab v1 baseline. PR #23 was
limited to graph frontier computation, dirty propagation, cache preservation
and antichain maintenance. Receipts, event semantics, compaction and provider
cost were explicitly out of scope.

## Historical acceptance gate

An optimization could become the next champion only when it had:

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

and either 20% less graph work, 15% less validation/external work, or a
proven better worst-case complexity. PR24 does not inherit a reduction claim
from this historical report.

## Frozen work model

Mutation-time index and dirty propagation work is `maintenanceWork`. Frontier
queries and action preparation after the mutation are `queryWork`.

```text
WA_query        = query work / certified query minimum
WA_maintenance  = maintenance work / certified maintenance minimum
WA_total        = (query + maintenance) / certified total minimum
```

No ratio is claimed when the denominator is not certified. The PR24 report
still emits physical counters and locality ratios without inventing a
denominator.

## Reproducible command

```powershell
pnpm benchmark:efficiency:v1:frontier:check
```

The runner writes reports only under
`.tmp/premise-efficiency-lab/v1/frontier/` and labels 100k/1m profiles as
diagnostic until memory and independent holdout gates are provisioned.

The public smoke gate emits `report.md` and `summary.json`. These contain
physical primitive evidence only; they do not claim lower token usage,
provider cost, external reads or commercial savings.
