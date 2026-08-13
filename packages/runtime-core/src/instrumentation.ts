/**
 * Optional, side-effect-free runtime telemetry for Efficiency Lab v1 and
 * connector integrations. The runtime never consults these values when
 * making a safety decision.
 */
export const RUNTIME_COUNTER_FIELDS = Object.freeze([
  "nodesVisited",
  "edgesTraversed",
  "frontierNodesVisited",
  "frontierRecomputes",
  "frontierIncrementalUpdates",
  "indexLookups",
  "reverseIndexLookups",
  "dirtyPropagations",
  "invalidationPropagations",
  "branchesSkippedAlreadyDirty",
  "frontierCacheInvalidations",
  "frontierCacheEntriesPreserved",
  "receiptLookups",
  "receiptHits",
  "receiptMisses",
  "receiptSubsumptionHits",
  "staleReceiptRejections",
  "negativeCacheHits",
  "negativeCacheMisses",
  "cacheHits",
  "cacheMisses",
  "cacheEvictions",
  "sourceReads",
  "conditionalReads",
  "authoritativeReads",
  "eventContinuityChecks",
  "eventRepairs",
  "writeIntents",
  "CASAttempts",
  "CASConflicts",
  "CASSuccesses",
  "idempotentReplays",
  "fenceRejections",
  "singleFlightLeaders",
  "singleFlightJoins",
  "singleFlightSplits",
  "leaseAcquisitions",
  "leaseExpirations",
  "batchCount",
  "batchItems",
  "parallelBatches",
  "graphCompactions",
  "observationsCompacted",
  "auditNodesRetained",
  "recordReads",
  "recordBatchReads",
  "decisions"
] as const);

export type RuntimeCounterField = (typeof RUNTIME_COUNTER_FIELDS)[number];

export interface RuntimeOperationEvent {
  readonly field: RuntimeCounterField;
  readonly count?: number;
  readonly memoryId?: string;
  readonly sourceUri?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeDecisionEvent {
  readonly memoryId: string;
  readonly decision: "USABLE" | "REVALIDATE" | "REJECT" | "ALLOW" | "ACCEPTED";
  readonly reason?: string;
}

export type RuntimeOperationCounters = Readonly<Record<RuntimeCounterField, number>>;

export interface RuntimeInstrumentation {
  readonly onOperation?: (event: RuntimeOperationEvent) => void;
  readonly onDecision?: (event: RuntimeDecisionEvent) => void;
  readonly snapshot?: () => RuntimeOperationCounters;
}

export function emptyRuntimeOperationCounters(): RuntimeOperationCounters {
  return Object.freeze(Object.fromEntries(RUNTIME_COUNTER_FIELDS.map((field) => [field, 0])) as Record<RuntimeCounterField, number>);
}

function assertCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("runtime operation count must be a non-negative integer");
}

/** A deterministic recorder suitable for tests, adapters and benchmark traces. */
export class RuntimeInstrumentationRecorder implements RuntimeInstrumentation {
  private counters = { ...emptyRuntimeOperationCounters() } as Record<RuntimeCounterField, number>;
  private readonly decisionEvents: RuntimeDecisionEvent[] = [];

  readonly onOperation = (event: RuntimeOperationEvent): void => {
    if (!RUNTIME_COUNTER_FIELDS.includes(event.field)) throw new RangeError(`unknown runtime counter: ${event.field}`);
    const count = event.count ?? 1;
    assertCount(count);
    this.counters[event.field] = (this.counters[event.field] ?? 0) + count;
  };

  readonly onDecision = (event: RuntimeDecisionEvent): void => {
    if (event.memoryId.length === 0 || event.decision.length === 0) throw new TypeError("runtime decision event is incomplete");
    this.decisionEvents.push(Object.freeze({ ...event }));
    this.onOperation({ field: "decisions" });
  };

  snapshot(): RuntimeOperationCounters {
    return Object.freeze({ ...this.counters });
  }

  decisions(): readonly RuntimeDecisionEvent[] {
    return Object.freeze([...this.decisionEvents]);
  }

  reset(): void {
    this.counters = { ...emptyRuntimeOperationCounters() } as Record<RuntimeCounterField, number>;
    this.decisionEvents.length = 0;
  }
}

export function recordRuntimeOperation(
  instrumentation: RuntimeInstrumentation | undefined,
  field: RuntimeCounterField,
  count = 1,
  metadata?: Readonly<Record<string, unknown>>
): void {
  if (count === 0) return;
  // Telemetry is deliberately best-effort. A broken observer must never turn
  // a safe runtime operation into a failed operation or alter a decision.
  try {
    instrumentation?.onOperation?.({ field, count, ...(metadata === undefined ? {} : { metadata }) });
  } catch {
    // Observers are diagnostics, not part of the protocol state machine.
  }
}
