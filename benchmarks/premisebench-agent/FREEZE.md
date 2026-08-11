# PremiseBench-Agent experimental freeze

The scientific work in this branch starts from the last clean deterministic
benchmark commit:

```text
bff0977 Optimize batched validation and connector reads
```

That commit is the frozen pre-scientific baseline. Changes after it create a
new benchmark version; existing artifacts are not rewritten to manufacture a
better number.

The preregistered development run records its own commit, worktree state,
Node version, pnpm version, runner hash, scenario hashes, seed, task-set hash,
and power calculation in `.tmp/scientific-mvp/<round>/plan.json` and
`manifest.json`.

`--holdout=true` is available only with a round name containing `holdout`. The
holdout seed must be supplied explicitly and is written to the private local
artifact after execution. This is a deterministic release-candidate control,
not an independent external evaluation: an external custodian and signed
attestation are still required for a public holdout claim.

Unknown, missing, and provider-unavailable measurements remain `UNKNOWN`,
`NOT_MEASURED`, or `NOT_RUN`; they are never converted to zero.
