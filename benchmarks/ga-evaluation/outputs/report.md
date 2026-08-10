# GA Evaluation 1.0.0

Run: `ga-20260810113536-f131e8a3`
Generated: `2026-08-10T11:35:41.644Z`
Split: `all`
Tasks: **22**
Blind protocol: `ga-evaluation/1`

## Verification

- Datasets verified: **11**
- Hash algorithm: **sha256**
- External evidence only: **true**
- Fixture evidence accepted: **false**
- Dataset verification requests: **11**

## Aggregate metrics

Rates use all selected tasks except freshness, whose denominator is available answers. Latency is p50 / p95 / p99 in milliseconds.

| Strategy | Tasks | Correct | Freshness | False positives | Availability | Latency p50 / p95 / p99 ms | Requests | Estimated cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| direct-read | 22 | 100.00% | 100.00% | 0.00% | 100.00% | 18.712 / 31.832 / 36.434 | 22 | $0.00012576 |
| ttl-cache | 22 | 81.82% | 72.73% | 18.18% | 100.00% | 0.171 / 30.947 / 34.131 | 12 | $0.00007103 |
| retrieval-no-protocol | 22 | 77.27% | 68.18% | 22.73% | 100.00% | 0.001 / 0.002 / 0.014 | 7 | $0.00004100 |
| PREMiSE | 22 | 100.00% | 100.00% | 0.00% | 100.00% | 21.668 / 40.044 / 64.912 | 30 | $0.00015962 |

## Split metrics

| Strategy | Split | Tasks | Correct | Freshness | False positives | Availability | Latency p50 / p95 / p99 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| direct-read | visible | 10 | 100.00% | 100.00% | 0.00% | 100.00% | 18.924 / 36.434 / 36.434 |
| direct-read | hidden | 6 | 100.00% | 100.00% | 0.00% | 100.00% | 0.22 / 23.047 / 23.047 |
| direct-read | holdout | 6 | 100.00% | 100.00% | 0.00% | 100.00% | 18.954 / 28.069 / 28.069 |
| ttl-cache | visible | 10 | 70.00% | 70.00% | 30.00% | 100.00% | 0.202 / 30.947 / 30.947 |
| ttl-cache | hidden | 6 | 83.33% | 66.67% | 16.67% | 100.00% | 0.171 / 34.131 / 34.131 |
| ttl-cache | holdout | 6 | 100.00% | 83.33% | 0.00% | 100.00% | 0.002 / 28.729 / 28.729 |
| retrieval-no-protocol | visible | 10 | 60.00% | 60.00% | 40.00% | 100.00% | 0.001 / 0.014 / 0.014 |
| retrieval-no-protocol | hidden | 6 | 83.33% | 66.67% | 16.67% | 100.00% | 0.001 / 0.002 / 0.002 |
| retrieval-no-protocol | holdout | 6 | 100.00% | 83.33% | 0.00% | 100.00% | 0.001 / 0.002 / 0.002 |
| PREMiSE | visible | 10 | 100.00% | 100.00% | 0.00% | 100.00% | 21.668 / 64.912 / 64.912 |
| PREMiSE | hidden | 6 | 100.00% | 100.00% | 0.00% | 100.00% | 0.408 / 40.044 / 40.044 |
| PREMiSE | holdout | 6 | 100.00% | 100.00% | 0.00% | 100.00% | 20.259 / 39.502 / 39.502 |

## Allowed claims

- This run supports only the reported exact-answer, source-freshness, false-positive, availability, request, latency, and source-operation cost observations for this manifest, dataset hashes, runner version, and environment.
- A PREMiSE result here means the version-gated reference behavior named **PREMiSE**; it is not a claim about every implementation or deployment.
- Public-source evidence was fetched and hash-checked before evaluation.

## Claims not allowed

- No universal truth, model intelligence, semantic retrieval quality, production SLA, provider invoice, security guarantee, or causal product uplift may be inferred from this run.
- Static public snapshots do not prove recovery from a live mutation. The changed-snapshot tasks measure a reproducible version transition, not a live repository mutation campaign.
- Holdout numbers must not be tuned on and must not be reported without the manifest, dataset hashes, raw traces, and independent reproduction.
