# PREMiSE Codex plugin

This plugin packages the PREMiSE agent workflow and a standalone MCP server.
The workflow teaches evidence identity, freshness checks, fail-closed
decisions, and guarded side effects. The runtime remains the authority for
validation and action enforcement.

## Install it in any agent project

From the project where Codex, Claude Code or another MCP-compatible agent will
work, install the candidate in one command:

```bash
npx --yes --package github:Dafenxz0/premise-protocol#v2.0.0-rc.2 premise-install --agent all --project .
```

For an offline or reviewed checkout, run the installer directly:

```bash
node plugins/premise-codex/install.mjs --agent all --project .
node plugins/premise-codex/install.mjs --check --agent all --project .
```

The installer has no package dependencies. It installs the shared skill for
Codex, a managed `CLAUDE.md` import for Claude Code, a generic `AGENTS.md`
note, and a portable MCP configuration. It preserves unrelated instructions
and MCP servers. See [`docs/agent-installation.md`](../../docs/agent-installation.md)
for the copy-from-GitHub command, Windows PowerShell examples and remote mode.

The plugin directory can be copied outside this repository: its MCP command is
resolved from `mcp/server.mjs` inside the copied plugin and does not depend on
the monorepo, a workspace alias, or a build output elsewhere.

The MCP server starts in zero-config `SELFTEST` mode and exposes the
deterministic `selftest:premise` sample. `SELFTEST` is an install/transport
check, not a local coherence store and not a source of truth. Set
`PREMISE_MODE=REMOTE` and provide `PREMISE_BASE_URL` to connect the same tools
to an HTTP deployment. The optional `PREMISE_TENANT` and `PREMISE_TOKEN` values
must be passed only at runtime; never commit them to `.mcp.json`.

The `guard` tool is a safety check, not a side-effect executor: it returns a
decision and requires a connector-owned conditional write.

The plugin is a repository artifact while PREMiSE is a candidate release. It
does not claim that the registry package or an external connector is
available. See docs/adoption-reality-wave.md for the evidence boundary.
