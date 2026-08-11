# PREMiSE repository map

Status: scope freeze for the evidence-first v2 workstream.

Baseline: `origin/main` at `54b6bef` (the production PostgreSQL and live read-only GitHub evidence remains historical evidence; it is not silently relabelled as an agent efficacy result).

## What exists today

| Area | Current location | Classification | Action in this phase |
| --- | --- | --- | --- |
| Historical contract | `spec/premise-v0.1.md`, `spec/test-vectors/` | `spec-legacy` | Preserve and document compatibility. |
| Current v2 contract | `spec/v2/`, `spec/schemas/` | `spec` | Preserve; do not call it the minimal portable contract. |
| Minimal portable contract | `spec/premise-1/` | `spec` | New evidence-first contract, deliberately small. |
| TypeScript runtime | `packages/runtime-core/`, `packages/reference-ts/` | `core` | Preserve public imports; add premise/1 reference separately. |
| Storage and integrations | `packages/store-*`, `packages/validator-*`, `packages/connector-*` | `adapter` | Keep opt-in; not part of conformance core. |
| Security and HTTP | `packages/security-core/`, `packages/premise-server/`, `ops/`, `deploy/` | `deploy` | Existing GA candidate surface; out of the primitive proof. |
| Existing benchmark suites | `benchmarks/real-world-v2/`, `benchmarks/ga-*`, `benchmarks/*context*`, `benchmarks/comparative-bench/` | `benchmark` / `legacy` | Preserve results; label the new causal benchmark separately. |
| New causal benchmark | `benchmarks/premisebench-agent/` | `benchmark` | Primary benchmark for changing-world agent tasks. |
| Examples and demo | `examples/`, `apps/` | `generated` / `demo` | Keep existing examples; add a dependency-free killer demo. |
| Traces and root reports | `traces/`, `results.json`, `summary.md`, `conformance-report.json` | `generated` | Do not extend checked-in generated output; new artifacts are ignored. |

## Package map

The current workspace contains runtime and protocol packages (`protocol-types`, `reference-ts`, `runtime-core`, `context-engine`, `index-*`, `store-*`, `security-core`, `sdk`, `premise-server`, `mcp-bridge`, `testkit`) plus source validators and connectors (`validator-filesystem`, `validator-git`, `validator-github`, `connector-webhook`, `adapter-openai`). They are useful implementation layers, but none is the normative premise/1 contract.

## Benchmark map

- `premise-memory-bench`: current TypeScript package-level benchmark.
- `real-world-bench`: earlier live/fixture connector benchmark.
- `real-world-v2`: live GitHub read-only and deterministic connector comparison.
- `ga-evaluation`: candidate/holdout and acceptance suites; retained as historical/GA evaluation.
- `ga-load`, `ga-soak`, `ga-cost`: operational scale evidence; retained as production evidence.
- `long-context-bench`, `context-corpus-bench`, `giant-context-v2`: context/scale evidence, not proof of stale-memory safety.
- `comparative-bench`, `evaluation`: historical comparisons.
- `premisebench-agent`: new task-level benchmark; the only suite allowed to make agent efficacy claims after independent holdout review.

## Compatibility and move rules

1. No existing file is deleted or moved in the scope-freeze change.
2. Existing package names and exports remain stable.
3. New conformance code must depend on the minimal contract, not on retrieval, embeddings, a database, or a cloud service.
4. Generated benchmark output lives under ignored `benchmarks/premisebench-agent/artifacts/` and is referenced by a manifest, never mixed with source.
5. Physical moves happen only in a later repository-organization PR, one block at a time, after `pnpm typecheck`, package tests, and import checks.

## Proposed destination (later, non-destructive)

```text
spec/premise-1/       # minimal portable contract
spec/premise-legacy/  # compatibility wrapper for 0.1 and v2 docs
reference/typescript/
reference/python/
conformance/
adapters/{filesystem,git,github,postgres,mcp}/
benchmarks/premisebench-agent/
docs/{protocol,benchmarks,integration,operations}/
```

The existing package tree is intentionally not moved until compatibility exports and CI coverage exist.
