# Runtime journal and checkpoints

PREMiSE has two different persistence questions:

- operational state: the bounded records, indexes, receipts, and frontier needed to answer the next check;
- audit history: the events and decisions needed to explain or replay what happened.

They must not be treated as the same collection. `@premise/runtime-core` now exposes an opt-in `RuntimeJournal` with an in-memory implementation for tests and a JSONL `FileJournal` for local recovery. The runtime can send committed events and decisions to that journal without making the journal an oracle or a replacement for the source system's conditional write.

```ts
const journal = new FileJournal("./var/premise/events.jsonl");
const runtime = new PremiseRuntime({ store, journal, tenantId: "tenant:acme" });
```

Journal cursors are monotonic and reads are exclusive: `readFrom(10)` returns entries after cursor 10. Event appends are idempotent by tenant and idempotency key. A malformed final JSONL line is treated as a torn write and truncated; malformed history in the middle of the file fails closed.

`FileJournal` also exposes the additive `readPage(cursor, { limit, tenantId? })` capability. It returns at most `limit` entries, the cursor to use for the next page, and `hasMore`; pages are exclusive of the supplied cursor. `FileJournal` validates the JSONL file incrementally during construction and reads pages incrementally from disk, so it does not retain a full history `entries` array. Its memory use is bounded by the requested page, one in-flight JSONL line, the latest checkpoint state, and the event idempotency index needed to preserve append recovery semantics. The index still grows with the number of unique events, and each page rescans the file from the beginning; this is bounded-memory pagination, not random access or an async streaming iterator. The compatibility `readFrom` method remains unchanged and can still materialize a full result when called without `limit`.

Runtime checkpoints are separate, digest-bound objects. They contain the active record set and the minimum operational frontier, incarnation, receipt, idempotency, source-version, dependency, and event-cursor state required to resume. `verifyRuntimeCheckpointRecovery` accepts only a contiguous journal tail after the checkpoint cursor.

## Current boundary

This wave is intentionally additive. `InMemoryRuntimeStore.compactOperational` now proves the checkpoint-plus-tail commit protocol: it prepares and validates the complete replacement before swapping state, retains compact idempotency metadata, and never touches the audit journal. Existing SQLite/PostgreSQL stores still retain their compatibility event index because their durable compaction path has not yet been implemented. A journal-enabled production deployment must therefore still be described as an audit sidecar plus compatibility store, not as fully compacted distributed persistence.

The journal is diagnostic/audit infrastructure. A journal write failure is isolated from the safety decision already committed to the runtime store; deployments that require a complete audit trail must monitor and fail the operation at the orchestration boundary when the journal is unavailable.
