# PREMiSE boundary

PREMiSE is a coherence protocol and runtime boundary for information that can
change between observation and action.

## What it provides

- evidence identity and observed versions;
- freshness states: FRESH, STALE, INVALID, and UNKNOWN;
- dependency invalidation;
- revalidation and conditional or guarded actions;
- receipts, idempotency, and explainable decisions where the selected runtime
  exposes them.

## What it does not provide

PREMiSE does not decide whether a source is morally or universally true. It
does not replace the source system, a vector database, embeddings, retrieval,
an LLM, or a provider's authorization. A validator reports what it observed;
the protocol decides whether that observation is still usable for the scoped
operation.

## Safe decision table

| Evidence state | Read-only use | Consequential action |
| --- | --- | --- |
| FRESH | permitted within scope | revalidate or use a bound guard |
| STALE | re-read and re-plan | reject until revalidated |
| INVALID | reject | reject |
| UNKNOWN | surface uncertainty | reject or request a new authoritative check |

Keep tenant, resource, incarnation, version, validator, authorization, policy,
query, scopes, change set, and causal frontier aligned with the public
contract. Sharing a result with a broader scope is unsafe.
