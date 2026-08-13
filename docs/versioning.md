# PREMiSE versioning

PREMiSE has several layers that evolve at different speeds. A protocol version, a runtime package version, and an adapter SDK version are not interchangeable. This page is the short map for readers and integrators.

| Layer | Meaning | Stability today |
| --- | --- | --- |
| `premise/1` | Small portable evidence/version/validity contract and conformance vectors | Legacy compatibility contract; changes require an explicit version |
| `premise/1.1` | Additive causal and resource-coherence semantics built on the premise contract | Current specification work; use the published vectors, not an undocumented assumption |
| `premise/2` | Existing TypeScript runtime envelope and event model | Runtime implementation/compatibility layer, not a promise that every API is public stable |
| `premise-policy/1` | Policy decisions such as risk and sharing scope | Separate adjunct contract |
| `premise-guard/1` | Guarded action and receipt semantics | Separate adjunct contract |
| SDK and adapters | Programming interfaces for stores and external systems | Package-level semver; each adapter must declare its capabilities |

## Compatibility rules

1. A consumer that only needs the portable contract should implement `premise/1` and run the shared vectors.
2. A consumer that needs causal dependencies or resource-level coherence should opt into `premise/1.1` explicitly.
3. `premise/2` is the current runtime implementation surface. It may expose conveniences that are not part of the portable protocol.
4. Policy and guard contracts are additive. A runtime must not silently interpret a missing policy or guard field as a stronger safety guarantee.
5. An adapter owns its source-system revision, CAS, ETag, transaction, permission, and event-stream guarantees. A PREMiSE receipt cannot replace those checks.
6. A change that alters a decision, frontier, receipt, invalidation, or guard vector requires a new vector, a migration note, and an explicit compatibility decision.

## What the version number does not mean

`2.0.0-rc.1` describes the current workspace package release, not universal production readiness. It does not mean that every connector is durable, distributed, independently evaluated, or covered by a commercial availability guarantee. The evidence status for those claims lives in [`docs/evidence/README.md`](evidence/README.md).

## Choosing a starting point

- Use `premise/1` for a small independent implementation or a language port.
- Use `premise/1.1` when the application needs dependency-aware freshness and causal invalidation.
- Use the TypeScript runtime only when its store and adapter contracts fit the application, and keep the underlying source conditional write in place.
- Treat experimental benchmark APIs as evidence tooling, not as protocol surface.
