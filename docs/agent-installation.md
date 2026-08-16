# Install PREMiSE in an agent project

PREMiSE is a protocol, not a vendor-specific memory plugin. The portable kit
uses one dependency-free MCP server and one shared instruction file, then adds
the small host-specific bridge each agent understands.

## Two-minute installation

From the root of the project where the agent will work:

```bash
git clone --depth 1 https://github.com/Dafenxz0/premise-protocol.git .premise-source
node .premise-source/plugins/premise-codex/install.mjs --agent all --project .
node .premise-source/plugins/premise-codex/install.mjs --check --agent all --project .
```

The installer needs Node.js and no `pnpm install`, build, database or cloud
service. If you already have a PREMiSE checkout, run the installer directly:

```bash
node plugins/premise-codex/install.mjs --agent all --project .
```

`--agent all` is convenient. Use a single target when you want a smaller
installation:

| Host | Command | Files added |
| --- | --- | --- |
| Codex | `--agent codex` | `.agents/skills/premise` and project MCP config |
| Claude Code | `--agent claude-code` | managed `CLAUDE.md` import and project MCP config |
| Other MCP-compatible agents | `--agent generic` | managed `AGENTS.md` note and `.premise/premise.mcp.json` |

The installer is idempotent. It preserves unrelated MCP servers and existing
instructions. If a PREMiSE-managed file or server entry has been changed,
rerun with `--force` after reviewing the diff.

## Start safely

The default is `SELFTEST`. It proves that the host can start the copied MCP
server, but it is not a local coherence store and it does not represent a real
source of truth. Start the agent in the project after installation and inspect
the `premise` tools.

For a real PREMiSE HTTP deployment, keep credentials out of files and provide
them only to the process that starts the agent.

```bash
export PREMISE_MODE=REMOTE
export PREMISE_BASE_URL=https://premise.example.com/
export PREMISE_TENANT=acme
export PREMISE_TOKEN='provided-at-runtime'
claude
```

PowerShell:

```powershell
$env:PREMISE_MODE = "REMOTE"
$env:PREMISE_BASE_URL = "https://premise.example.com/"
$env:PREMISE_TENANT = "acme"
$env:PREMISE_TOKEN = "provided-at-runtime"
claude
```

Never commit `PREMISE_TOKEN` or put it in `.mcp.json`. Claude Code asks for
approval before using a project-scoped MCP configuration; use `/mcp` to inspect
the server and its tools. See the [Claude Code MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp)
for the host's current configuration and approval behavior.

## What each host receives

### Codex

The installer puts the public skill under `.agents/skills/premise`. Codex can
use it as `$premise`; the standalone MCP server is copied under
`.premise/premise-codex/mcp/server.mjs`.

### Claude Code

The installer appends one marked import to the project's `CLAUDE.md` and merges
the `premise` server into `.mcp.json`. It never replaces an existing
`CLAUDE.md` or unrelated MCP entries.

### Other agents

Load `.premise/premise.mcp.json` in any client that supports standard MCP
stdio. The instruction file is available at
`.premise/premise-codex/skills/premise/SKILL.md`; `AGENTS.md` records when an
agent should read it.

The server exposes `observe`, `check`, `explain` and a dry-run `guard`. A guard
never performs a side effect: the connector still owns authorization and the
conditional write.

## Remove the installation

The installer only owns the following paths. Remove them manually after
reviewing your project diff:

```text
.premise/premise-codex/
.premise/premise.mcp.json
.agents/skills/premise/
```

Also remove the marked PREMiSE block from `CLAUDE.md` and `AGENTS.md`; keep any
other content in those files.
