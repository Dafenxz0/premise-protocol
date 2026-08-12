# PREMiSE Efficiency Lab v0

Efficiency Lab models how much work PREMiSE policies would perform to preserve
the existing safety and coherence decisions. It is deterministic policy
calibration, not execution of the production runtime, a new protocol version,
or a production-scale claim.

The lab keeps three dimensions separate:

- **Safety:** unsafe actions, TOCTOU escapes, false blocks and unknown values
  incorrectly promoted to fresh.
- **External work:** requests, reads, writes and duplicate source reads.
- **Protocol work:** graph nodes, edges, dependency traversals, frontier work,
  propagated invalidations, receipt reuse, batching and latency.

The primary efficiency measure is Work Amplification:

```text
WA_external = external operations performed / minimum external operations
WA_graph    = graph operations performed / minimum graph operations
WA_validate = validations performed / minimum required validations
```

`1.0x` is the measured minimum for a scenario. Unknown denominators remain
`UNKNOWN`; they are never replaced with zero or an invented estimate.

The v0 runner also reports a declared logical latency model. It is useful for
comparing identical candidate work, but it is not wall-clock provider latency.
Real latency, provider cost and LLM tokens require a separate external campaign.

## Scope

v0 evaluates deterministic worlds with chain, star, diamond, deep DAG, wide
DAG and meshed DAG topologies. Mutation schedules include isolated changes,
simultaneous changes, bursts, duplicate events, reordered events and event
gaps. A gap is fail-closed: the event stream becomes `UNKNOWN` unless the
source capability proves the newer version authoritative.

The lab does not change `premise/1.1` semantics. Candidate optimizations must
produce the same decisions as the reference implementation and preserve
tenant, incarnation, causal-frontier, CAS and TOCTOU guarantees.

Generated artifacts belong under `.tmp/premise-efficiency-lab/` and are not
source code. Sealed holdout material and candidate mappings are never exposed
to an optimizing candidate.

## Quick checks

The first smoke command is intentionally local and small:

```powershell
node benchmarks/premise-efficiency-lab/smoke.mjs
```

The reproducibility and leakage gate is:

```powershell
node --test benchmarks/premise-efficiency-lab/efficiency-lab.test.mjs
node scripts/premise-efficiency-lab-self-check.mjs
```

The first non-smoke profile is opt-in:

```powershell
node benchmarks/premise-efficiency-lab/scale.mjs --profile=1000
```

The 100k/1m profiles require `--allow-diagnostic` and produce diagnostic
artifacts only. They do not establish production-scale support.

Full scale profiles are opt-in. A profile is diagnostic until it has passed
the reference-equivalence, safety and metric-integrity gates.

## Evidence boundary

This lab is the deterministic optimization layer. It does not yet prove a
real connector, an LLM behaviour change, a provider bill, or a commercial cost
reduction. Those claims stay unavailable until the same paired tasks pass an
external, blind, holdout campaign with measured tokens, cost and wall-clock
latency.
