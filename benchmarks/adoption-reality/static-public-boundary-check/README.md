# Static Public-Boundary Check

This is a deterministic, offline structural check of a public PREMiSE SDK
integration. It is not an agent run: it does not launch Codex or Luna, install
packages, call a server, or read credentials.

```powershell
node benchmarks/adoption-reality/static-public-boundary-check/checker.mjs
node benchmarks/adoption-reality/static-public-boundary-check/checker.mjs --self-check
```

The isolated input is [`fixtures/isolated-public-consumer`](./fixtures/isolated-public-consumer/).
It contains only a `README.md`, a `package.json`, and public Markdown under
`docs/`. The evaluator-only prompt manifest, checker, and candidate fixtures
are outside that input. The reference candidate is a static fixture; it is not
executed.

The checker accepts a candidate directory with `--candidate <path>`. A
candidate contains changed source files and an evaluator-produced `run.json`
trace. It must import only `@premise/sdk`, contain no private evaluator data,
and report reads from the public input. The result is JSON on stdout and
always includes:

- `success`
- `filesChanged`
- `internalImports`
- `docsReads`
- `errors`
- `timeToFirstSuccessMs`

The complete boundary and metric definitions are in
[`docs/static-public-boundary-check.md`](../../../docs/static-public-boundary-check.md).
