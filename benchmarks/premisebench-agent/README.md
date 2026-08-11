# PremiseBench-Agent

PremiseBench-Agent measures whether an agent can continue a task safely when the information it observed becomes old while it is working.

It is deliberately separate from retrieval, embeddings, databases, dashboards, and model quality. The benchmark first proves the causal control loop in a mutable world; live provider campaigns are opt-in and are reported as `NOT_RUN` when credentials or a controlled target are unavailable.

## Quick start

```text
node benchmarks/premisebench-agent/runner.mjs --tasks 100 --seed 20260811
node benchmarks/premisebench-agent/self-check.mjs
```

The smoke campaign uses a temporary filesystem world and a deterministic control agent. It is useful for validating the harness, not for promising production performance.

Outputs are written to the ignored directory `benchmarks/premisebench-agent/artifacts/`:

- `summary.json`: numbers by baseline.
- `report.md`: plain-language interpretation and caveats.
- `tables.md`: compact public tables.
- `traces.jsonl`: evaluator traces; `agentInput` contains no oracle.
- `manifest.json`: frozen run metadata.
- `dataset-manifest.json`: scenario and seed hashes.

## Baselines

| ID | Strategy |
| --- | --- |
| A | No-memory: read at action time, then act. |
| B | Normal memory: trust the initial observation. |
| C | Prompted re-check: read again before acting. |
| D | TTL cache: re-check only when the cache age exceeds a TTL. |
| E | Always revalidate: read before every action. |
| F | Version gate: compare versions before action, but do not protect the write itself. |
| G | Dependency gate: check the source dependency before action, but do not protect the write itself. |
| H | PREMiSE full: versioned revalidation plus compare-and-set write and retry. |

The controls are intentionally allowed to win on some dimensions. For example, direct re-reading can be safe but costs more requests; PREMiSE should earn its claim through the joint safety/cost/recovery table, not through a single favorable scenario.

## Live campaigns

Live GitHub and PostgreSQL worlds are adapters, not part of the default smoke path. They require a read-only GitHub token or an explicitly supplied PostgreSQL connection and a controlled target. No mutation is attempted against a user's ordinary repository. Missing credentials produce `NOT_RUN`, never `PASS`.

The experimental design and public metric definitions are frozen in [`DESIGN.md`](./DESIGN.md).
