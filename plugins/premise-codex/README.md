# PREMiSE Codex plugin

This plugin packages the PREMiSE agent workflow and a standalone MCP server.
The workflow teaches evidence identity, freshness checks, fail-closed
decisions, and guarded side effects. The runtime remains the authority for
validation and action enforcement.

The plugin directory can be copied outside this repository: its MCP command is
resolved from `mcp/server.mjs` inside the copied plugin and does not depend on
the monorepo, a workspace alias, or a build output elsewhere.

The MCP server starts in zero-config `LOCAL` mode and exposes the deterministic
`local:premise` sample. Set `PREMISE_MODE=REMOTE` and provide
`PREMISE_BASE_URL` to connect the same tools to an HTTP deployment. The
optional `PREMISE_TENANT` and `PREMISE_TOKEN` values are passed only at runtime.

The `guard` tool is a safety check, not a side-effect executor: it returns a
decision and requires a connector-owned conditional write.

The plugin is a repository artifact while PREMiSE is a candidate release. It
does not claim that the registry package or an external connector is
available. See docs/adoption-reality-wave.md for the evidence boundary.
