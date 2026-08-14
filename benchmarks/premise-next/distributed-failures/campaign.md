# PREMiSE NEXT distributed-failure campaign

This campaign is a deterministic contract smoke for the actual
`PostgresValidationFlightStore` class. It supplies a stateful in-memory
`PostgresAdapter` double that recognizes the store's emitted SQL, models
transaction-scoped tenant context and JSONB receipt round-trips, and keeps
monotonic fencing in the row state.

The default run is explicitly offline. It uses one Node process, no real
PostgreSQL connection and no simulated process count. The â€œleader crashâ€ fault
means completion is deliberately skipped; it does not claim that an OS process
was killed. Virtual timestamps are passed into the store, so the output has no
latency or wall-clock measurement.

## Focused commands

From the repository root:

```text
pnpm --filter @premise/store-postgres... build
node --test benchmarks/premise-next/distributed-failures/campaign.test.mjs
node benchmarks/premise-next/distributed-failures/runner.mjs
node benchmarks/premise-next/distributed-failures/self-check.mjs
```

The runner prints one compact JSON summary by default. Add `--pretty` for
inspection or `--seed=<value>` to reproduce another deterministic offline
fixture.

## Scenarios

| Scenario | Contract point |
| --- | --- |
| `leader-crash-before-completion` | skipped completion leaves a follower and permits later takeover after expiry |
| `expiry-takeover` | expiry replaces the leader with fencing token 2 and the replacement receipt completes |
| `old-leader-completion` | the old owner cannot complete after takeover |
| `duplicate-completion` | only the first completion is accepted and its receipt remains authoritative |
| `aba-scope-change` | A â†’ B â†’ A keeps the A fence monotonic and rejects the old A completion |
| `tenant-isolation` | same resource data remains separate for two tenants under tenant context/RLS checks |
| `follower-timeout-abort` | a follower timeout or already-aborted signal returns `TIMEOUT` without changing the flight |
| `receipt-replay` | claim, read and wait replay the same completed receipt |

## Optional live mode

Live mode is opt-in and never falls back to the offline double:

```text
POSTGRES_URL=postgres://... node benchmarks/premise-next/distributed-failures/runner.mjs --live
```

It requires both `POSTGRES_URL` and the `pg` package. The live adapter uses one
Node process and a PostgreSQL pool; it is still not evidence of multiple
processes, crash recovery, latency, throughput, capacity or production
durability. This campaign intentionally does not add a dependency, CI job or
runtime integration for live mode.

The campaign is scoped to this directory. It does not change the runtime,
coherence storm, Session work, CI, or repository README files.
