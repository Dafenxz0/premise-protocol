# PREMiSE v2 benchmark report

Run mode: **offline-temporal-fixture**

Paired user tasks: **100**

Seed: **premise-v2-real-world-v1**

Generated: **2026-08-10T22:37:35.420Z**

## Numbers people can read

Each row receives the same task order. **Precision** is exact answer equality;
errors count as wrong. **Freshness** requires both the answer and the observed
source version to match the evaluator's current label. Requests and bytes are
transparent cost proxies, not a billing quote.

| Strategy | Baseline | Protocol | Precise / 100 | Fresh / 100 | Requests / 100 | Response bytes / 100 | p50 | p95 | Errors / 100 |
|---|:---:|---|---:|---:|---:|---:|---:|---:|---:|
| direct-read | Sí | none | 100/100 | 100/100 | 100/100 | 732 B/100 | 0.001 ms | 0.007 ms | 0/100 |
| ttl-cache-20 | Sí | none | 96/100 | 96/100 | 25/100 | 180 B/100 | 0.001 ms | 0.003 ms | 0/100 |
| premise-event-cache | No | PREMiSE-v2-reference | 100/100 | 100/100 | 8/100 | 61 B/100 | 0.001 ms | 0.004 ms | 0/100 |

The row marked **baseline = Sí / protocol = none** is the no-protocol control.
The PREMiSE rows are reference implementations for this benchmark and do not
by themselves prove production connector performance.

## Blindness and evidence

- Public task manifest: [tasks.json](./tasks.json), SHA-256 sha256:8f2d67ba740b8d3682c2f7a8dd5a3264617d41fd173472ec2e6d606d6d425140.
- Hidden-label commitment: sha256:160175cb09c546fc0350f4100b7cd1707f833fbf2889d2a7bfd1faa964b4fb2e. Answers are not exported.
- Raw per-task evidence: [traces.jsonl](./traces.jsonl), SHA-256 sha256:7b4b5ddd18928901091ce690222cec735f0c02ceabc24f99cc85b221aaf357dd (300 lines).
- Claim boundary: **not eligible for a public product claim**; the run is not an independent attestation.

The evaluator retains labels separately in memory and only emits outcome flags,
versions, request metadata and hashes in the raw trace. Re-run the exact
command and compare the task manifest, table and raw trace before making a
claim.

## Connector evidence

PostgreSQL connector: **not run**. It is opt-in and requires an explicit database URL.

## Source and limitations

Source class: **local-deterministic-fixture**. Read-only: **true**. Network access: **false**.

- This is a deterministic fixture for CI, not a live GitHub claim.
- The fixture has exact answers and no model-generation step.
- The PREMiSE row is an event-invalidation reference implementation, not proof of production connector performance.
- Response bytes are serialized fixture values and are not a cloud billing measurement.
