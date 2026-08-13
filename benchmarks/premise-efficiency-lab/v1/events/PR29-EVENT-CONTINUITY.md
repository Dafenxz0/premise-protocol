# PR29 — ordered event continuity

Status: **contract hardening; runtime integration deliberately not claimed**.

This change adds a fail-closed ordered-stream evaluator for snapshot and delta
observations. It accepts exact duplicates that arrive at the current sequence,
but rejects gaps, late/reordered deliveries, same-sequence conflicts, stream
mismatches, malformed observations and deltas received before a required
snapshot.

The evaluator is a runtime utility, not an event transport or connector. The
current `V2Event` contract does not carry stream sequence metadata, and
`PremiseRuntime.applyEvent` still persists an event without using this
evaluator. Therefore this PR makes no claim about event-driven coherence,
provider requests, latency, throughput or cost.

## Evidence

The benchmark compares the complete result (`status`, terminal sequence,
applied sequence list, duplicate list or fail-closed reason) with an oracle in
[`oracle.mjs`](./oracle.mjs), executed in a separate Node process with no
runtime or runner imports. It also demonstrates that the legacy sorted helper
would incorrectly call adversarial late/gapped delivery fresh.

```powershell
pnpm benchmark:efficiency:v1:events
```

The unit suite includes ordered delivery, exact current duplicates, gaps,
late duplicates, conflicts, stream mismatches, snapshot requirements and
malformed events. The output is written to `.tmp/` and is not source evidence
until the command passes on a clean checkout.
