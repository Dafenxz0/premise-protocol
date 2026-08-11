# PREMiSE/1 conformance

`run.mjs` is the single conformance entry point for the new portable
`premise/1` contract. It executes the same nine semantic vectors against an
independent TypeScript reference and an independent Python reference, then
compares both outputs with the expected result.

```text
pnpm conformance:premise1
```

The command builds `reference/typescript/src/`, runs the Node CLI, runs
`reference/python/cli-premise1.py`, and exits non-zero on any mismatch. It
requires no database, network, model, or API key.

The historical v0.1/v2 package conformance remains under
`packages/conformance/` and is intentionally not mixed into this minimal
protocol gate.
