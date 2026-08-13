# Efficiency Lab v1 benchmark matrix

## Graph sizes

| Profile | Nodes | Status |
| --- | ---: | --- |
| smoke | 100 | CI |
| medium | 1,000 | CI/manual |
| large | 10,000 | required campaign |
| diagnostic-xl | 100,000 | diagnostic |
| diagnostic-xxl | 1,000,000 | diagnostic |

## Topologies

```text
chain
star
diamond
deep DAG
wide DAG
meshed DAG
```

## Mutation families

```text
isolated
simultaneous
burst
duplicate
reordered
gapped
late
alternating roots
delete/recreate
policy change
authorization change
```

## Adversarial campaigns

```text
validation-amplification
single-flight-stampede
long-horizon-drift
receipt-cache-adversarial
```

## Concurrency and horizon

Consumers: `1`, `10`, `100`, `1,000`.

Steps: `1`, `10`, `100`, `1,000`.

## Candidate families

```text
Memory
TTL/Smart
IndependentSmart
Always Revalidate
PREMiSE current
PREMiSE incremental
PREMiSE incremental + frontier compression
```

Risk-aware planners are evaluated as policies, not as new protocol versions:

```text
balanced
conservative
event-first
read-minimizing
incremental
```
