# Standalone MCP server

`server.mjs` is intentionally dependency-free and is distributed inside the
plugin. It does not resolve `packages/`, `workspace:` dependencies, or a
monorepo-relative path.

The default is zero-config `LOCAL` mode. It exposes the deterministic
`local:premise` sample memory so the plugin can be installed and inspected
without a deployment or credential:

```text
PREMISE_MODE=LOCAL
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
