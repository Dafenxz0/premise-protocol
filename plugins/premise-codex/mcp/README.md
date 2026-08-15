# Standalone MCP server

`server.mjs` is intentionally dependency-free and is distributed inside the
plugin. It does not resolve `packages/`, `workspace:` dependencies, or a
monorepo-relative path. It speaks the standard MCP newline-delimited stdio
transport; clients should launch it through the official MCP stdio transport.

The default is zero-config `SELFTEST` mode. It exposes the deterministic
`selftest:premise` sample memory so the plugin can be installed and inspected
without a deployment or credential. `SELFTEST` is not local coherence and must
not be used as a source of truth:

```text
PREMISE_MODE=SELFTEST
```

To point the same tools at a PREMiSE HTTP deployment, use:

```text
PREMISE_MODE=REMOTE
PREMISE_BASE_URL=https://premise.example.com/
PREMISE_TENANT=acme
PREMISE_TOKEN=provided-at-runtime
```

`guard` is deliberately a dry-run. It may return `ALLOW` only after a fresh
validation, reports `requiresConditionalWrite`, and never executes a side
effect.
