# PREMiSE v2 benchmark report

Run mode: **live-github-readonly**

Tasks: **100**

Generated: **2026-08-10T11:43:18.180Z**

## Simple numbers

| Strategy | Correct / 100 | Requests / 100 | p50 | p95 | Errors / 100 |
|---|---:|---:|---:|---:|---:|
| direct-read | 100/100 | 100/100 | 0 ms | 0.001 ms | 0/100 |
| ttl-cache-20 | 100/100 | 85/100 | 305.545 ms | 370.306 ms | 0/100 |
| premise-conditional-cache | 100/100 | 9/100 | 0.035 ms | 308.63 ms | 0/100 |

These are workload measurements, not product guarantees. "Correct" means exact equality with the benchmark truth for this run. Request count is a transparent cost proxy, not a billing quote.

## Scope and limitations

- Read-only campaign: no public repository mutation is performed.
- Answers are exact API payload equality after removing only GitHub's ephemeral download_url query token and temp_clone_token metadata.
- Conditional requests are counted as requests even when GitHub returns 304.
- A release claim requires repeated runs and a separate changed-source campaign.

Raw per-task traces are stored in [traces.jsonl](./traces.jsonl). Re-run the exact command and compare both the table and raw traces before making a claim.
