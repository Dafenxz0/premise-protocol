# PREMiSE Efficiency Lab

The repository contains two explicitly different layers:

- **v0 calibration**: the historical deterministic policy model described
  below; it is preserved for comparison and does not execute `runtime-core`.
- **v1 physical lab**: the implementation path that executes the real runtime,
  records physical operations and applies the frozen contracts in
  [the v1 preregistration](./EFFICIENCY-LAB-V1-PREREGISTRATION.md).

Efficiency Lab v1 is the current implementation target. It must not report a
modelled operation as if it came from the production runtime.

## Historical v0 model

The v0 runner models how much work PREMiSE policies would perform to preserve
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

## v1 physical lab

The v1 runner executes the built `@premise/runtime-core` artifact with a
deterministic mutable source adapter. It records the runtime's physical
counter stream, keeps an independent `IndependentSmart` comparator, generates
four adversarial fixture families, and uses a certified minimum-work oracle.
The first campaign is deliberately labelled `in-process-calibration` until
the candidate/oracle child-process boundary and sealed holdout pass their own
gates; it must not be used for a commercial claim.

The local process-boundary smoke can be run separately:

```powershell
pnpm benchmark:efficiency:v1:sealed
```

It reports `sealed/local` only: the candidate is a child process and the
mutation broker stays in the parent, but this is not an external holdout, an
OS sandbox, or a commercial result.

Run the v1 checks with:

```powershell
pnpm build
node --test benchmarks/premise-efficiency-lab/v1/**/*.test.mjs
node benchmarks/premise-efficiency-lab/v1/self-check.mjs
node benchmarks/premise-efficiency-lab/v1/campaign.mjs --tasks=24
```

The campaign writes only under `.tmp/premise-efficiency-lab/v1/` when an
output path is supplied or the CLI is used. Its blind report is not a
holdout result until physical process isolation is certified.

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
