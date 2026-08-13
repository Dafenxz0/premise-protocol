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

Runtime checkpoints are separate, digest-bound objects. They contain the active record set and the minimum operational frontier, incarnation, receipt, idempotency, source-version, dependency, and event-cursor state required to resume. `verifyRuntimeCheckpointRecovery` accepts only a contiguous journal tail after the checkpoint cursor.

## Current boundary

This wave is intentionally additive. Existing stores still retain their compatibility event index because `RuntimeStore` and the SQLite/PostgreSQL adapters expose it today. PR38 will add the durable checkpoint-plus-tail compaction path and prove that releasing old operational objects does not delete the audit journal. Until that gate passes, a journal-enabled runtime must be described as “audit sidecar plus compatibility store”, not as fully compacted production persistence.

The journal is diagnostic/audit infrastructure. A journal write failure is isolated from the safety decision already committed to the runtime store; deployments that require a complete audit trail must monitor and fail the operation at the orchestration boundary when the journal is unavailable.
