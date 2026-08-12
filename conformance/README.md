# PREMiSE/1 conformance

`run.mjs` is the single conformance entry point for the portable `premise/1`
contract. It keeps the two vector suites separate:

- The nine compact vectors in `spec/premise-1/vectors/` run against an
  independent TypeScript reference and an independent Python reference. Both
  outputs are compared with the expected result in each vector.
- The five wire vectors in `spec/premise-1/test-vectors/` are loaded from
  their manifest and registered individually as `NOT_RUN`. There is no
  independent `premise/1` wire reference available yet, so the runner does
  not derive or assert wire expectations from an implementation.

```text
pnpm conformance:premise1
```

The command builds `reference/typescript/src/`, runs the Node CLI, runs
`reference/python/cli-premise1.py`, and exits non-zero on any mismatch. It
requires no database, network, model, or API key. A successful compact gate
keeps the compatible message:

```text
PREMiSE/1 conformance: PASS (9 vectors; TypeScript == Python == expected)
```

The wire-suite record is explicit and is not a PASS:

```text
PREMiSE/1 wire conformance: NOT_RUN (5 vectors; no independent premise/1 wire reference available)
```

Handoff: add an independent `premise/1` wire reference/executor before
changing those five records from `NOT_RUN`; that implementation is outside
this conformance-only change.

The historical v0.1/v2 package conformance remains under
`packages/conformance/` and is intentionally not mixed into this minimal
protocol gate.
