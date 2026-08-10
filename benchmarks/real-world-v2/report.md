# PREMiSE v2 benchmark report

Run mode: **offline-temporal-fixture**

Tasks: **100**

Generated: **2026-08-10T10:41:32.399Z**

## Simple numbers

| Strategy | Correct / 100 | Requests / 100 | p50 | p95 | Errors / 100 |
|---|---:|---:|---:|---:|---:|
| direct-read | 100/100 | 100/100 | 0 ms | 0.001 ms | 0/100 |
| ttl-cache-20 | 96/100 | 25/100 | 0 ms | 0.002 ms | 0/100 |
| premise-event-cache | 100/100 | 8/100 | 0 ms | 0.003 ms | 0/100 |

These are workload measurements, not product guarantees. "Correct" means exact equality with the benchmark truth for this run. Request count is a transparent cost proxy, not a billing quote.

## Scope and limitations

- This is a deterministic fixture for CI, not a live GitHub claim.
- The fixture has exact answers and no model-generation step.

Raw per-task traces are stored in [traces.jsonl](./traces.jsonl). Re-run the exact command and compare both the table and raw traces before making a claim.
