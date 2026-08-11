# Repository organization plan

This is a map and a safe sequence, not a mass move. The current package names
and public exports remain stable until a compatibility test proves a move is
safe.

## Target layout

```text
spec/premise-1/                    # minimal portable protocol
spec/premise-legacy/               # future compatibility index only
reference/{typescript,python}/
conformance/
adapters/{filesystem,git,github,postgres,mcp}/
benchmarks/premisebench-agent/     # causal benchmark
benchmarks/{ga-evaluation,real-world-v2,giant-context-v2}/
docs/{protocol,benchmarks,integration,operations}/
```

## Safe sequence

1. Keep an inventory and freeze the current baseline.
2. Add new routes and compatibility exports before moving anything.
3. Move one small block, run Node 24 typecheck/tests, and inspect imports.
4. Compare old and new outputs on the same vectors.
5. Update links and package metadata.
6. Delete a duplicate only after its replacement is covered by CI and its
   historical result is preserved or explicitly classified.
7. Never commit generated traces, build output, credentials or external
   benchmark artifacts as source.

## Do not move yet

`packages/runtime-core`, `packages/protocol-types`, public SDK/server exports,
PostgreSQL migrations, deploy workflows, historical GA evidence and existing
v0.1/v2 vectors are compatibility boundaries. `REPO_MAP.md` records the full
classification and the reason for each boundary.

## Classification rule

Every new file must be one of `core`, `spec`, `adapter`, `benchmark`, `deploy`,
`generated` or `legacy`. A file that cannot be classified belongs in
`BACKLOG.md` before it is added.
