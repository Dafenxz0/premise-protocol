# Runtime instrumentation schema v1

The v1 lab counts operations emitted by the real runtime. Counters are
diagnostic telemetry; they do not alter decisions or authorize an action.

## Trace envelope

Each task produces one deterministic JSON object:

```json
{
  "format": "premise-efficiency-lab/physical-trace/v1",
  "taskId": "task-0001",
  "candidateId": "blind-only",
  "commit": "sha256:...",
  "counters": {},
  "decisions": [],
  "status": "COMPLETE"
}
```

`candidateId` in candidate-visible traces is an opaque assignment. The
private mapping is kept by the referee and is never passed to the candidate.

## Counter fields

All counter fields are non-negative integers. Missing measurements are
`UNKNOWN` at report time, not zero.

### Graph and frontier

```text
nodesVisited
edgesTraversed
frontierNodesVisited
frontierRecomputes
frontierIncrementalUpdates
indexLookups
reverseIndexLookups
dirtyPropagations
invalidationPropagations
branchesSkippedAlreadyDirty
```

`nodesVisited` and `edgesTraversed` refer to an actual runtime traversal.
`frontierNodesVisited` and `frontierRecomputes` are emitted only when the
incremental frontier is explicitly queried; invalidation traversal must not
be relabelled as frontier work. `frontierIncrementalUpdates` counts a real
dirty-index update.

### Evidence and caches

```text
receiptLookups
receiptHits
receiptMisses
receiptSubsumptionHits
staleReceiptRejections
negativeCacheHits
negativeCacheMisses
cacheHits
cacheMisses
cacheEvictions
```

### Sources and writes

```text
sourceReads
conditionalReads
authoritativeReads
recordReads
recordBatchReads
eventContinuityChecks
eventRepairs
writeIntents
CASAttempts
CASConflicts
CASSuccesses
idempotentReplays
fenceRejections
```

### Concurrency and batching

```text
singleFlightLeaders
singleFlightJoins
singleFlightSplits
leaseAcquisitions
leaseExpirations
batchCount
batchItems
parallelBatches
```

### History

```text
graphCompactions
observationsCompacted
auditNodesRetained
```

`recordReads` counts records returned through the store path and
`recordBatchReads` counts a physical `getMany` call, not merely a request with
multiple IDs. Receipt counters are emitted only by an actual receipt/cache
implementation or instrumented adapter; evidence-array length is never used
as a proxy for `receiptLookups`.

### Decisions

```text
decisions
```

This is the number of decision events emitted by the runtime. It is a trace
volume counter, not a safety result.

## Counting rules

- A single-flight join is not another physical source read.
- A CAS conflict is still one write attempt.
- A complete observation returned atomically by a CAS may satisfy the next
  validation read, but the second CAS remains a separate attempt.
- An event signal is counted separately from a source read.
- Reordered, duplicate and gapped event handling counts continuity work.
- Local cache operations count as protocol work, not external reads.
- A zero-count event is omitted; absent implementation support is represented
  as `UNKNOWN` by the report layer rather than fabricated as physical work.
- Counter collection must be deterministic and disabled without changing
  observable behavior.
- A trace must identify the counter schema version.

## API shape

The runtime exposes an optional observer through `RuntimeOptions`. The
observer receives operation events and a final immutable snapshot. Existing
callers that omit the observer retain current behavior.

```ts
interface RuntimeInstrumentation {
  readonly onOperation?: (event: RuntimeOperationEvent) => void;
  readonly onDecision?: (event: RuntimeDecisionEvent) => void;
  readonly snapshot?: () => RuntimeOperationCounters;
}
```

The concrete interfaces live in `packages/runtime-core/src/instrumentation.ts`
and are exported from the runtime package after their contract tests pass.
