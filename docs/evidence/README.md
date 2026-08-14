# PREMiSE evidence index

This index distinguishes implementation status from measured evidence. A benchmark result is not a product guarantee: it is valid only for its frozen workload, evaluator, adapters, and assumptions.

## Current status

| Area | Evidence | Status | Interpretation |
| --- | --- | --- | --- |
| Baseline accounting | Efficiency Lab PR24 | Measured | Baseline accounting and cost denominators are documented |
| Incremental frontier resolve | Efficiency Lab PR26 | Measured | Reuse is bounded by explicit frontier semantics |
| Dirty propagation | Efficiency Lab PR27 | Measured | Local invalidation avoids unrelated work in the tested graph |
| Exact receipt reuse | Efficiency Lab PR28 | Measured | Exact compatible receipts can be reused under their scope |
| Event continuity | Efficiency Lab PR29 | Contract evidence | Helpers and vectors exist; end-to-end runtime integration is a next wave |
| Long horizon | Efficiency Lab PR30–33 | Measured with limits | Heap and snapshot behavior were observed; operational history is not yet separated from audit history |
| Bounded runtime campaign | PR39 harness | Smoke measured; full scale opt-in | Audit count, operational tail, idempotency window, and checkpoint recovery are reported separately |
| Safe compaction | PR31 no-go; PR38 in-memory gate | **PARTIAL** | The in-memory checkpoint-plus-tail swap passes crash/idempotency tests; durable SQLite/PostgreSQL compaction remains unproven |
| Root-explosion experiment | PR25 | **INCONCLUSIVE** | The campaign did not establish a mergeable production claim |
| External provider / independent holdout | Scientific campaign | Not run or incomplete | No commercial claim should be derived from it |
| PREMiSE NEXT semantic conformance | PR57, 15 shared TypeScript vectors plus 24 Python cases | Measured semantic slice | The full guarded-action chain is not yet cross-language equivalent |
| Distributed validation coordination | PR58 flight adapter and deterministic fault campaign | Contract/fault smoke | The campaign uses the real flight class with an in-memory adapter; real PostgreSQL/process capacity remains opt-in |

## Evidence locations

- [`benchmarks/premise-efficiency-lab/FRONTIER-CYCLES.md`](../../benchmarks/premise-efficiency-lab/FRONTIER-CYCLES.md) — campaign map.
- [`benchmarks/premise-efficiency-lab/v1/frontier/`](../../benchmarks/premise-efficiency-lab/v1/frontier/) — baseline, incremental resolve, and dirty propagation.
- [`benchmarks/premise-efficiency-lab/v1/receipts/`](../../benchmarks/premise-efficiency-lab/v1/receipts/) — receipt reuse and scope accounting.
- [`benchmarks/premise-efficiency-lab/v1/events/`](../../benchmarks/premise-efficiency-lab/v1/events/) — event continuity contract evidence.
- [`benchmarks/premise-efficiency-lab/v1/horizon/`](../../benchmarks/premise-efficiency-lab/v1/horizon/) — long-horizon runner, oracle, and tamper checks.
- [`benchmarks/premise-efficiency-lab/v1/compaction/`](../../benchmarks/premise-efficiency-lab/v1/compaction/) — compaction gate and explicit no-go result.
- [`docs/scientific-mvp.md`](../scientific-mvp.md) — frozen methodology and claim boundaries for agent evaluation.

## Reading a result

Every publishable campaign should include:

1. the immutable workload and seed manifest;
2. the adapter and runtime version;
3. the evaluator rules and oracle isolation proof;
4. raw trace and summary digests;
5. safety, freshness, work, latency, and cost denominators;
6. negative, failed, not-run, and inconclusive cases.

If one of these is missing, the result may still be useful for local debugging, but it is not evidence for a public performance or safety claim.

## Next evidence gate

The next evidence gate is integration hardening: a canonical validation identity,
the actual single-flight and PostgreSQL-flight implementations under storm and
failure workloads, a bounded/durable idempotency policy, and a paged journal
adapter. Credentialed PostgreSQL, multi-process crash recovery, external
holdouts and provider-cost campaigns must remain explicitly `skipped` until
their infrastructure and manifests are present. The million-step campaign is
a scalability experiment, not a claim that PREMiSE has been tested at
enterprise scale.
