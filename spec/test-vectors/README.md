# PREMiSE v0.1 test vectors

This directory is a language-neutral conformance corpus for `premise/0.1`.
It describes protocol effects, not a TypeScript API. An implementation in any
language can load the JSON, execute the ordered `steps`, and compare the
`expect` blocks.

## Layout

`manifest.json` is the stable entry point. Each suite contains independent
vectors; a runner may execute one vector without relying on another vector's
state.

| File | Coverage |
| --- | --- |
| `01-registration-and-derivation.json` | Fresh registration and derived memories. |
| `02-status-transitions.json` | TTL, notification, epoch, validation outcomes, unknown, repair, and `check()`. |
| `03-propagation-and-graphs.json` | Exact propagation, unrelated branches, and rejected cycles. |
| `04-check-and-capabilities.json` | The complete usability decision table and capability declarations. |
| `05-replay.json` | Deterministic event replay and history preservation. |

## Vector contract

Every vector has this shape:

```json
{
  "format": "premise-test-vector/0.1",
  "protocol": "premise/0.1",
  "vectorId": "stable-id",
  "category": "positive",
  "description": "What the vector proves",
  "parameters": {},
  "initial": {
    "clock": { "mode": "manual", "now": "2026-08-09T19:20:00Z" },
    "memories": []
  },
  "steps": [
    {
      "id": "stable-step-id",
      "operation": "register",
      "input": {},
      "expect": {}
    }
  ]
}
```

`category` is one of `positive`, `negative`, or `transition`. A negative
vector is expected to reject an operation and leave state and history
unchanged unless its `expect` block explicitly says otherwise.

The harness operations are deliberately small:

- `register` accepts `{ "envelope": <complete memory envelope> }`.
- `derive` accepts an envelope whose `dependsOn` entries already exist.
- `signal` accepts a canonical `SourceChanged` event or the graph projection
  `{ "memoryId": "...", "change": "version" }`.
- `register_graph` loads a dependency graph projection whose edges point from a
  dependent to its support; `advance_time` moves the manual clock and applies
  TTL expiry.
- `validate` supplies a validator result for each requested memory. The
  result outcomes are `UNCHANGED`, `CHANGED`, `MISSING`, and `UNKNOWN`.
- `check` returns `USABLE`, `REVALIDATE`, or `REJECT` for each memory.
- `capabilities` evaluates a declaration of `RECORD`, `DEPENDENCY`,
  `REVALIDATION`, `RETRIEVAL`, and `GATE`.
- `replay` applies an ordered event log to an empty state.

These operation names are test-harness vocabulary. Every step has a stable
`id`, every vector has a deterministic `initial` clock/state, and any event
inside `replay` or `signal` uses the canonical event shape. `expect.events`
uses the portable projection `{type, memoryId, at}` where `at` is the canonical
event's `occurredAt`; it is not itself a wire event. The normative protocol
effects are the resulting statuses, emitted event types, dependency graph, and
usability decisions.

## Comparison rules

- Timestamps are fixed UTC strings. No vector depends on wall-clock time.
- Event arrays are ordered history. Set-like arrays such as propagated IDs are
  sorted by `memoryId`.
- `dependsOn` order is significant only where it appears in an expected event;
  implementations may canonicalize it when the protocol treats dependencies as
  a set.
- A state assertion includes only the listed memories, but every listed field
  is exact. `status`, `dependsOn`, and `provenanceVersions` are the portable
  state projection used by these vectors.
- `expect.events` contains the exact events emitted by the step. Rejected
  operations emit no event unless stated otherwise.
- `expect.sameAs` compares the canonical JSON result of two replay steps. Object
  key order is irrelevant; array order is not.

## Normative state rules exercised here

The vectors encode the v0.1 rules without depending on an implementation:

1. Registration with current evidence is `FRESH`.
2. A derived memory is invalid if any dependency is invalid; otherwise
   `UNKNOWN` outranks `STALE`, and `STALE` outranks `FRESH`.
3. A TTL expiry, source notification, or epoch change makes the affected
   memory `STALE`.
4. `CHANGED` and `MISSING` validator outcomes make a memory `INVALID`.
5. `UNKNOWN` validator outcomes make a memory `UNKNOWN`.
6. `UNCHANGED` with the recorded version may restore `FRESH`.
7. Propagation visits only the changed source and reachable dependants; it does
   not delete historical records or touch unrelated branches.
8. Dependency cycles are rejected.
9. `check()` maps `FRESH` to `USABLE`, `STALE`/`UNKNOWN` to `REVALIDATE`, and
   `INVALID` to `REJECT`.
10. `RECORD`, `DEPENDENCY`, and `REVALIDATION` are required for the v0.1
    compatibility claim. `RETRIEVAL` and `GATE` remain explicit optional
    capabilities.
