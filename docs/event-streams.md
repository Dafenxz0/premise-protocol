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

The current wave is contract-only. `PremiseRuntime.applyEvent`, SQLite, PostgreSQL, HTTP, and SDK paths still accept legacy `V2Event` and do not claim stream continuity or snapshot repair. The next wave integrates this envelope into an apply/repair state machine and must explicitly handle gaps, reordered deliveries, same-sequence conflicts, duplicate pages, and authoritative snapshots.
