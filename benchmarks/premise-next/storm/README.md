# PREMiSE NEXT coherence storm

This is PR52's deterministic contract smoke. It reuses 100 logical workers
through eight isolated phases and uses only injectable in-memory doubles. The
same worker count is deliberate: the benchmark tests the protocol decisions
under a storm; it is not a claim that a machine ran 100 distributed processes.

Run it with Node 24:

```text
node benchmarks/premise-next/storm/runner.mjs
node --test benchmarks/premise-next/storm/runner.test.mjs
```

The runner prints a JSON report. `seed` fixes all identifiers and
`elapsedMs` is virtual deterministic time, not wall-clock throughput. Physical
validation work and joins are counted separately so coalescing cannot hide the
connector work.

## Phases

| Phase | What it exercises | Expected shape |
| --- | --- | --- |
| `exact-coalescing` | 100 callers with the same tenant, resource, version and authorization scope | 1 physical validation, 99 joins |
| `authorization-scopes` | The same evidence requested with read and write scopes | 2 physical validations, no cross-scope join |
| `100-tenants-same-resource` | 100 tenants address the same resource identifier | 100 isolated validations, no cross-tenant share |
| `lease-expiry` | A lease expires while the source read is still blocked | the old result is unknown and a replacement gets a newer fence |
| `leader-timeout` | A blocked leader times out while 99 followers are waiting | all 100 callers receive `UNKNOWN`; no implicit retry |
| `source-mutation-during-validation` | The source changes from A to B before the read is released | callers observe stale/changed evidence and cannot act |
| `event-during-flight` | An invalidating event arrives before the read completes | the flight is fenced and callers receive `UNKNOWN` |
| `old-fence-and-aba` | A → B → A with the old A flight still in progress | old A and B fences cannot commit; only current A may act |

## Counters

- `physicalValidations`: source reads actually started by the in-memory source.
- `joins`: callers attached to an existing exact flight.
- `crossTenantShares` / `crossScopeShares`: forbidden joins; both must be zero.
- `staleOutcomes` / `unknownOutcomes`: logical worker outcomes, including
  coalesced followers.
- `sideEffectAttempts`: conditional action attempts made by the scenario;
  negative phases intentionally attempt stale/unknown results to test rejection.
- `sideEffectCommits`: actions accepted by the in-memory CAS/fence gate.
- `staleAccepted` / `oldFenceCommits`: safety violations; both must be zero.
- `elapsedMs`: deterministic virtual elapsed time used for comparing runs.

The runner fails closed if any of the three public safety assertions fails:
no cross-tenant sharing, no stale accepted, and no old-fence commit.

## Deliberate boundary

This smoke does **not** prove distributed correctness, a lease service, a
database transaction, process crash recovery, network behavior, or production
capacity. There is no external service, real clock, real process worker,
network, database, retry loop or hidden oracle. The source, clock, event
signal, lease expiry and conditional side-effect gate are injectable local
doubles. A production claim requires connector-specific and multi-process
evidence in addition to this contract smoke.
