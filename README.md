# PREMiSE Protocol

PREMiSE is a protocol for keeping agent-memory metadata synchronized with the world. It records provenance, observed versions, validity states, explicit dependencies, events, and revalidation behavior. It does not own memory content, retrieval, embeddings, vector search, or an agent framework.

This private repository contains the `v0.1.0-rc.1` reference workspace:

- `spec/`: normative specification, JSON Schemas, and language-neutral vectors.
- `packages/protocol-types`: runtime-safe envelope and event types/parser.
- `packages/reference-ts`: deterministic DAG, state machine, events, replay, validation and `check()`.
- `packages/index-sqlite`: metadata/event sidecar using Node 24 `node:sqlite`.
- `packages/validator-filesystem` and `packages/validator-git`: local validators.
- `packages/adapter-openai` and `packages/mcp-bridge`: integration boundaries without vendor SDK calls.
- `packages/conformance`: adapter contract and vector validation runner.
- `benchmarks/premise-memory-bench`: deterministic engine, worlds, baselines, metrics and smoke CLI.
- `examples/`: generic-memory, OpenAI-memory and MCP-memory demonstrations.

## Quick start

Use Node.js 24 and pnpm 10:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Useful gates:

```text
pnpm test:properties
pnpm conformance
pnpm benchmark:smoke
pnpm benchmark -- --runner minimal --suite v0.1
pnpm examples:verify
pnpm artifacts:generate
```

The benchmark loads 40 filesystem/Git/GitHub-like scenarios, 10 static
controls, and 5 capability ablations. It emits a deterministic
`premise-benchmark-results/0.1` report and one JSON trace per scenario. The
conformance suite validates and executes all 16 language-neutral vectors so
other implementations can replay the same cases.

## Protocol boundary

`FRESH` is usable, `STALE` and `UNKNOWN` require revalidation, and `INVALID` must be rejected as current support. Dependency aggregation is `INVALID > UNKNOWN > STALE > FRESH`; cycles are rejected and unrelated branches are not cascaded. Invalidating metadata never deletes the memory content or history.

The v0.1 release deliberately excludes vector databases, embeddings, semantic retrieval, LLM dependency inference, a cloud service, a dashboard, and a real GitHub adapter.

## Release status

The repository is private and has no license by design. CI runs install, build, unit tests, property tests, conformance, benchmark smoke, and example verification. `pnpm artifacts:generate` refreshes `conformance-report.json`, `results.json`, `traces/`, and `summary.md`; release claims must be backed by those artifacts rather than by a baseline assumption.
