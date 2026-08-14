# PREMiSE ordered event streams

`V2StreamEvent` is an additive wire contract for connectors that deliver an ordered source stream. It keeps the legacy `V2Event` contract unchanged and adds:

- `streamId`: the logical source stream, scoped together with `tenantId`;
- `sequence`: a non-negative stream-local sequence;
- `kind`: `SNAPSHOT` or `DELTA`;
- optional opaque `cursor` and connector-declared `sourceVersion`.

`V2EventStreamPage` carries the tenant, stream, events, current `headSequence`, and an optional `nextCursor`. Page validation preserves delivery order and checks tenant/stream identity; it does not sort or pretend that a page is continuous. Consumers must use ordered continuity state across page boundaries.

The stream sequence is not the same thing as a journal cursor or a PostgreSQL row sequence. The stream sequence belongs to the source connector; the journal cursor belongs to PREMiSE persistence. They must never be compared as if they were one clock.

```ts
const page = parseV2EventStreamPage(input);
const continuity = assessOrderedEventContinuity(page.events, {
  expectedSequence: consumer.nextSequence,
  requireSnapshot: consumer.needsSnapshot
});
```

PR40 established the wire contract. The runtime now exposes additive `PremiseRuntime.applyStreamEvent`, which validates continuity and fails closed on gaps, reordering, conflicts, and deltas before a snapshot. The compatibility store, SQLite/PostgreSQL adapters, HTTP, and SDK paths still accept legacy `V2Event`; connector authentication and durable transactional snapshot repair remain adapter responsibilities.

The runtime also exposes `repairStreamFromSnapshot(page)` for a terminal page that has already been authenticated and authorized by an adapter. The page must begin with `SNAPSHOT`, contain a contiguous sequence through `headSequence`, and omit `nextCursor`. The runtime validates those boundaries before applying events, treats exact persisted replays as duplicates, and leaves the stream fenced at the repair start if storage fails part-way through. This is an in-memory runtime path; adapter authentication and durable transactional repair remain adapter responsibilities.

For bursts, `applyStreamBurst(events, { capabilities })` may discard only the prefix covered by a later authoritative snapshot. Delta-only or capability-poor bursts stay ordered and are processed one by one; non-contiguous input is never sorted into safety. The coalescer reports skipped sequence numbers so the optimization is observable rather than free work hidden from metrics.
