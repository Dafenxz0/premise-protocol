# GA Evaluation 1.0.0

Run: `ga-20260810193923-bbac217a`
Generated: `2026-08-10T19:39:29.116Z`
Split: `all`
Tasks: **22**
Blind protocol: `ga-evaluation/1`

## Verification

- Source evidence: **external-public-static**; pinned and hash-verified: **true**
- Execution evidence: **local-runner**; independent: **false**
- Synthetic data accepted: **false**; detected markers: **0**
- Datasets verified: **11**
- Hash algorithm: **sha256**
- External source evidence only: **true**
- Fixture evidence accepted: **false**
- Dataset verification requests: **11**

## Aggregate metrics

Accuracy uses all selected tasks; freshness uses available answers; availability is a usable USE answer; latency is p50 / p95 / p99 in milliseconds including errors.

| Strategy | Tasks | Accuracy | Freshness | False positives | Availability | Error rate | Latency p50 / p95 / p99 ms | Requests | Cost proxy / 1,000 tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| direct-read | 22 | 100.00% | 100.00% | 0.00% | 100.00% | 0.00% | 18.743 / 21.729 / 23.35 | 22 | $0.00565638 |
| ttl-cache | 22 | 81.82% | 72.73% | 18.18% | 100.00% | 0.00% | 0.513 / 20.073 / 20.299 | 12 | $0.00318809 |
| retrieval-no-protocol (baseline without protocol) | 22 | 77.27% | 68.18% | 22.73% | 100.00% | 0.00% | 0.001 / 0.002 / 0.007 | 7 | $0.00186366 |
| PREMiSE | 22 | 100.00% | 100.00% | 0.00% | 100.00% | 0.00% | 19.76 / 39.768 / 41.493 | 30 | $0.00717960 |

## Split metrics

| Strategy | Split | Tasks | Correct | Freshness | False positives | Availability | Latency p50 / p95 / p99 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| direct-read | visible | 10 | 100.00% | 100.00% | 0.00% | 100.00% | 18.793 / 23.35 / 23.35 |
| direct-read | hidden | 6 | 100.00% | 100.00% | 0.00% | 100.00% | 0.525 / 19.944 / 19.944 |
| direct-read | holdout | 6 | 100.00% | 100.00% | 0.00% | 100.00% | 18.743 / 21.729 / 21.729 |
| ttl-cache | visible | 10 | 70.00% | 70.00% | 30.00% | 100.00% | 0.584 / 20.073 / 20.073 |
| ttl-cache | hidden | 6 | 83.33% | 66.67% | 16.67% | 100.00% | 0.513 / 20.299 / 20.299 |
| ttl-cache | holdout | 6 | 100.00% | 83.33% | 0.00% | 100.00% | 0.002 / 18.923 / 18.923 |
| retrieval-no-protocol | visible | 10 | 60.00% | 60.00% | 40.00% | 100.00% | 0.001 / 0.007 / 0.007 |
| retrieval-no-protocol | hidden | 6 | 83.33% | 66.67% | 16.67% | 100.00% | 0 / 0.001 / 0.001 |
| retrieval-no-protocol | holdout | 6 | 100.00% | 83.33% | 0.00% | 100.00% | 0.001 / 0.001 / 0.001 |
| PREMiSE | visible | 10 | 100.00% | 100.00% | 0.00% | 100.00% | 19.799 / 41.493 / 41.493 |
| PREMiSE | hidden | 6 | 100.00% | 100.00% | 0.00% | 100.00% | 0.739 / 38.17 / 38.17 |
| PREMiSE | holdout | 6 | 100.00% | 100.00% | 0.00% | 100.00% | 19.136 / 39.768 / 39.768 |

## Allowed claims

- This run supports only the reported exact-answer, source-freshness, false-positive, availability, request, latency, and source-operation cost observations for this manifest, dataset hashes, runner version, and local execution environment.
- A PREMiSE result here means the version-gated reference behavior named **PREMiSE**; it is not a claim about every implementation or deployment.
- Public-source evidence was fetched and hash-checked before evaluation; the metrics and runner execution remain local evidence.

## Claims not allowed

- No universal truth, model intelligence, semantic retrieval quality, production SLA, provider invoice, security guarantee, or causal product uplift may be inferred from this run.
- Static public snapshots do not prove recovery from a live mutation. The changed-snapshot tasks measure a reproducible version transition, not a live repository mutation campaign.
- Holdout numbers must not be tuned on and must not be reported as independent without an external holdout attestation.
