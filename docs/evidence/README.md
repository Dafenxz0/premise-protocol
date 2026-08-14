# PREMiSE evidence index

This index distinguishes implementation status from measured evidence. A benchmark result is not a product guarantee: it is valid only for its frozen workload, evaluator, adapters, and assumptions.

## Current status

| Area | Evidence | Status | Interpretation |
| --- | --- | --- | --- |
| Baseline accounting | Efficiency Lab PR24 | Measured | Baseline accounting and cost denominators are documented |
| Incremental frontier resolve | Efficiency Lab PR26 | Measured | Reuse is bounded by explicit frontier semantics |
| Dirty propagation | Efficiency Lab PR27 | Measured | Local invalidation avoids unrelated work in the tested graph |
| Exact receipt reuse | Efficiency Lab PR28 | Measured | Exact compatible receipts can be reused under their scope |
| Event continuity | Efficiency Lab PR29; NEXT runtime stream/repair | Measured contract slice | Ordered streams, continuity checks, and snapshot repair are covered; connector-specific end-to-end evidence remains separate |
| Long horizon | Efficiency Lab PR30–33; bounded FileJournal pages | Measured with limits | Operational state is bounded and journal reads are paged; each file page still rescans the file, so durable random-access storage is not proven |
| Bounded runtime campaign | PR39 harness | Smoke measured; full scale opt-in | Audit count, operational tail, idempotency window, and checkpoint recovery are reported separately |
| Safe compaction | PR31 no-go; PR38 in-memory gate | **PARTIAL** | The in-memory checkpoint-plus-tail swap passes crash/idempotency tests; durable SQLite/PostgreSQL compaction remains unproven |
| Root-explosion experiment | PR25 | **INCONCLUSIVE** | The campaign did not establish a mergeable production claim |
| External provider / independent holdout | Scientific campaign | Not run or incomplete | No commercial claim should be derived from it |
| PREMiSE NEXT semantic conformance | PR57, 15 shared TypeScript vectors plus 24 Python cases | Measured semantic slice | Canonical validation scope and the current vector set are protected; the full guarded-action chain is not yet cross-language equivalent |
| Session + Adapter SDK | NEXT integration hardening | Measured API slice | PremiseSession accepts the public Adapter SDK and owns derivation; HTTP end-to-end deployment remains adapter-specific |
| Guarded-tool idempotency | NEXT integration hardening | Bounded in-memory policy | Retention is explicit and fail-closed; durable external replay storage is still required for process restarts |
| Distributed validation coordination | PR58, PR66, PR69, PR70 | Contract/fault smoke | Storm and failure campaigns exercise the real fenced coordinator with complete scope; real PostgreSQL/process capacity remains opt-in |

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

The next evidence gate is independent integration evidence: credentialed
PostgreSQL and multi-process crash recovery, durable random-access journal
storage, the remaining cross-language guarded-action vectors, external
holdouts, and provider-cost campaigns. Repository CI now protects the
canonical scope, executable quickstart, real in-process storm, distributed
failure smoke, NEXT conformance, and bounded runtime gates. Anything that
requires credentials or external infrastructure must remain explicitly
`skipped` until its infrastructure and manifests are present. The million-step
campaign is a scalability experiment, not a claim that PREMiSE has been tested
at enterprise scale.
