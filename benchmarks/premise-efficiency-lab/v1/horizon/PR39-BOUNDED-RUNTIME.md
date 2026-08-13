# PR39 bounded-runtime campaign

`bounded-campaign.mjs` exercises the new checkpoint-plus-tail path with a fixed active world, a growing audit journal, and a bounded operational tail. It is deliberately a storage/recovery campaign: it does not claim to benchmark dependency propagation or connector latency.

## Run it

The default smoke campaign is intentionally small:

```bash
pnpm benchmark:efficiency:v1:bounded:test
pnpm benchmark:efficiency:v1:bounded
```

An opt-in long campaign can be run with the same deterministic policy:

```bash
pnpm --filter @premise/runtime-core build
node benchmarks/premise-efficiency-lab/v1/horizon/bounded-campaign.mjs \
  --horizons=1000,10000,100000,1000000 \
  --world-sizes=8,100,10000 \
  --tail-size=256 \
  --checkpoint-every=10000
```

The full Cartesian matrix is intentionally opt-in because the in-memory journal retains audit history for the experiment. A production-scale run must use a durable streaming journal implementation and report its disk, network, and recovery costs separately.

## Metrics

The report separates:

- `auditEntries`: events retained for audit/replay;
- `finalEventTail` and `peakEventTail`: event objects retained by operational state;
- `finalIdempotencyKeys` and `peakIdempotencyKeys`: compact replay metadata retained by the store;
- `records`: active records after each checkpoint;
- `checkpoints`: successful checkpoint-plus-tail swaps;
- `fullReplayProtection`: whether the configured tail still covers the complete event horizon.

The campaign is `INCONCLUSIVE` when the operational tail is bounded but the configured tail is shorter than the full event history. That outcome is intentional: bounded memory without a durable/idempotent replay boundary is not a safety win. The campaign must not be converted into a production or commercial claim.
