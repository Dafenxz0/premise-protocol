# PREMiSE NEXT coherence storm

This is a deterministic contract smoke for the real
`FencedSingleFlightCoordinator` loaded from `packages/runtime-core/dist`. It
reuses 100 logical workers through seven isolated phases and uses one
deterministic in-memory source fixture. The same worker count is deliberate:
the benchmark tests runtime decisions under a storm; it is not a claim that a
machine ran 100 distributed processes.

Run it with Node 24:

```text
node benchmarks/premise-next/storm/runner.mjs
node --test benchmarks/premise-next/storm/runner.test.mjs
```

The runner prints a JSON report. `seed` fixes all identifiers and
`elapsedMs` is virtual deterministic time, not wall-clock throughput. Physical
validation work and joins are counted separately so coordinator sharing cannot
hide the source work. The fixture supplies the source read, gates, mutation,
and conditional side-effect check; it does not implement coalescing or
fencing.

## Phases

| Phase | What it exercises | Expected shape |
| --- | --- | --- |
| `exact-coalescing` | 100 callers with the same complete validation scope | 1 physical validation, 99 joins |
| `authorization-scopes` | The same evidence requested with read and write scopes | 2 physical validations, no cross-scope join |
| `100-tenants-same-resource` | 100 tenants address the same resource identifier | 100 isolated validations, no cross-tenant share |
| `timeout-via-coordinator` | The real coordinator timeout fires while the source read is blocked | all 100 callers receive `UNKNOWN`; no implicit retry |
| `abort-signal-during-flight` | The shared caller signal aborts while the source read is blocked | all 100 callers receive `UNKNOWN/ABORTED` |
| `source-mutation-during-validation` | The source changes from A to B before the read is released | callers observe stale/changed evidence and cannot act |
| `old-fence-and-aba` | A -> B -> A with the old A flight still in progress | old A and B fences cannot commit; only current A may act |

## Counters

- `physicalValidations`: source reads actually started by the in-memory source.
- `joins`: callers receiving the exact same promise from the real coordinator,
  measured by promise identity in the benchmark (not a second coalescer).
- `crossTenantShares` / `crossScopeShares`: forbidden joins; both must be zero.
- `staleOutcomes` / `unknownOutcomes`: logical worker outcomes, including
  coalesced followers.
- `sideEffectAttempts`: conditional action attempts made by the scenario;
  negative phases intentionally attempt stale/unknown results to test rejection.
- `sideEffectCommits`: actions accepted by the in-memory conditional gate.
- `staleAccepted` / `oldFenceCommits`: safety violations; both must be zero.
- `elapsedMs`: deterministic virtual elapsed time used for comparing runs.

The runner fails closed if any of the three public safety assertions fails:
no cross-tenant sharing, no stale accepted, and no old-fence commit.

## Deliberate smoke boundary

This smoke does **not** prove distributed correctness, a lease service, a
database transaction, process crash recovery, network behavior, or production
capacity. There is no external service, real clock, real process worker,
network, database, retry loop or hidden oracle. `FencedSingleFlightCoordinator`
currently exposes timeout and caller abort, but no `expire()` or event
invalidation method; therefore `leaseExpiries` remains zero and the event phase
uses the real `AbortSignal` contract. The source, clock, timers, gates, and
conditional side-effect check are local doubles. A production claim requires
connector-specific and multi-process evidence in addition to this smoke.
