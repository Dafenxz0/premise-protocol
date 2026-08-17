# PREMiSE versioning

PREMiSE has several layers that evolve at different speeds. A protocol version, a runtime package version, and an adapter SDK version are not interchangeable. This page is the short map for readers and integrators.

| Layer | Meaning | Stability today |
| --- | --- | --- |
| `premise/2` | Current public HTTP contract and candidate runtime envelope | Current candidate protocol; use the published SDK and adapter contracts |
| `premise/1` | Small portable evidence/version/validity contract and conformance vectors | Frozen legacy compatibility contract; changes require an explicit version |
| `premise/1.1` | Additive causal and resource-coherence semantics built on the premise contract | Frozen compatibility specification; use the published vectors, not an undocumented assumption |
| PREMiSE NEXT | Experimental semantic slices and coordination contracts | Opt-in research surface; not stable or part of the current candidate |
| `premise-policy/1` | Policy decisions such as risk and sharing scope | Separate adjunct contract |
| `premise-guard/1` | Guarded action and receipt semantics | Separate adjunct contract |
| SDK and adapters | Programming interfaces for stores and external systems | Package-level semver; each adapter must declare its capabilities |

## Compatibility rules

1. A new HTTP integration should target `premise/2` through `@premise/sdk` and negotiate that exact contract.
2. An embedded TypeScript integration may use `@premise/runtime-core`, but its adapter must still own source authorization and conditional writes.
3. A portable implementation or language port may target frozen `premise/1` or `premise/1.1` and run the shared vectors.
4. PREMiSE NEXT must be explicitly opted into; it is not an implicit upgrade from any stable contract.
5. Policy and guard contracts are additive. A runtime must not silently interpret a missing policy or guard field as a stronger safety guarantee.
6. An adapter owns its source-system revision, CAS, ETag, transaction, permission, and event-stream guarantees. A PREMiSE receipt cannot replace those checks.
7. A change that alters a decision, frontier, receipt, invalidation, or guard vector requires a new vector, a migration note, and an explicit compatibility decision.

## What the version number does not mean

`2.0.0-rc.2` describes the current candidate package release, not universal production readiness. It does not mean that every connector is durable, distributed, independently evaluated, or covered by a commercial availability guarantee. The evidence status for those claims lives in [`docs/evidence/README.md`](evidence/README.md).

## Choosing a starting point

- Use `premise/2` for the current public candidate and `@premise/sdk` for HTTP clients.
- Use frozen `premise/1` or `premise/1.1` for independent implementations and compatibility ports.
- Use the TypeScript runtime only when its store and adapter contracts fit the application, and keep the underlying source conditional write in place.
- Treat experimental benchmark APIs as evidence tooling, not as protocol surface.
