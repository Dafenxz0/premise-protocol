# PREMiSE product golden path

PREMiSE is a change-control guardrail for agents. It does not replace GitHub,
PostgreSQL, an HTTP API or an agent's reasoning. The source remains authoritative;
PREMiSE records what the agent observed and asks the source for an atomic answer
before a side effect is allowed.

## The shortest integration

The public `PremiseSession` façade exposes two levels:

- `prepareAction()` separates observation from commitment. Use it when the agent
  needs to reason, call tools or wait before writing.
- `guardedWrite()` is the one-shot form for an action that can be observed and
  committed immediately.

```ts
import { premise } from "@premise/runtime-core";

const session = premise.session({ tenant: "acme", adapter });

const prepared = await session.prepareAction({
  source: "github://acme/service/pull/42",
  action: { type: "merge" }
});

// The agent may reason here. No side effect has happened yet.
const decision = session.check(prepared.premise);

if (decision.decision === "USABLE") {
  const outcome = await prepared.commitIfFresh();
  if (outcome.status === "blocked" && outcome.retryable) {
    // Re-observe and make a new decision. Do not replay the old premise.
    console.log(outcome.code);
  }
}
```

`commitIfFresh()` does not execute an arbitrary callback. It delegates the final
write to the adapter's `conditionalAction` capability. That capability must be
backed by the source's own atomic primitive: an HTTP `If-Match`, a PostgreSQL
compare-and-swap/transaction, or an equivalent GitHub version check.

## What the adapter owns

| Responsibility | Owner |
| --- | --- |
| Authentication and authorization | Connector / source system |
| Reading the source and its version | Adapter |
| Revalidating the observed version | Adapter |
| Atomic conditional write | Adapter and source |
| Evidence, dependencies and decision state | PREMiSE runtime |
| Re-observing after a block | Agent integration |

An adapter that can only read can still provide observations, but a guarded write
will fail closed with `ACTION_NOT_ATOMIC`. PREMiSE does not turn an ordinary write
into a safe write by wrapping it in a prompt.

## Result codes

The result is deliberately small and machine-readable:

| Code | Meaning | Safe next step |
| --- | --- | --- |
| `STALE_SOURCE` | The source version changed or could not satisfy the recorded premise. | Observe again and re-plan. |
| `VALIDATION_UNAVAILABLE` | PREMiSE could not establish enough authoritative evidence. | Retry only under an explicit policy; otherwise stop. |
| `ACTION_NOT_ATOMIC` | The adapter has no conditional write boundary. | Add CAS/ETag/transaction support or do not write. |
| `POLICY_DENIED` | The current premise or policy rejects the action. | Surface the decision; do not bypass the guard. |
| `IDEMPOTENCY_CONFLICT` | A replay key is already bound to a different action. | Stop and investigate the caller. |

The runtime keeps lower-level reasons such as `VERSION_MISMATCH` internal to the
adapter boundary and maps them to the stable product result `STALE_SOURCE`.
The session façade currently emits the first four results directly; durable
idempotency stores use `IDEMPOTENCY_CONFLICT` when a replay key is bound to a
different action.

## Connector examples

- **HTTP:** observe the representation and ETag, then use `If-Match` for the
  conditional action. A `412 Precondition Failed` becomes `STALE_SOURCE`.
- **PostgreSQL:** observe the row version or digest, then update with a version
  predicate inside a transaction. A zero-row update becomes `STALE_SOURCE`.
- **GitHub:** observe the commit/PR head and use a connector-specific conditional
  mutation. Read-only GitHub validation is available today; a production write
  adapter must still be authorized and tested against a controlled repository.

## What this does not promise

PREMiSE can prove that the source did not move past the version the agent observed.
It cannot prove that the agent's goal, code, permissions or business decision is
correct. It also cannot make a non-atomic connector safe, provide a vector index,
or act as a universal memory/database replacement.

For the visual explanation, run the dependency-free [Agent Change Control demo](../apps/agent-change-control/README.md).
