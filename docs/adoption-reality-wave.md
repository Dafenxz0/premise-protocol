# PREMiSE Adoption & Reality Wave

This document freezes the evidence boundary for the public-adoption work.

## Baseline

- Baseline commit: cb6583c (portable PREMiSE change-control product path)
- Working branch: agent/release-candidate-product-hardening
- Runtime requirement: Node 24 and pnpm 10
- Release channel: candidate `2.0.0-rc.2`
- Current public protocol: `premise/2`
- Public facade target: @premise/sdk
- License: Apache-2.0

The GitHub repository is public. The root package remains private as a
workspace source tree; `@premise/sdk@2.0.0-rc.2` and the standalone plugin are
the explicitly documented distribution surfaces.

## Scope freeze

The core protocol is frozen for this wave. A change to the runtime or protocol
is allowed only when it fixes a demonstrated correctness bug, closes a
semantic safety gap, or materially improves an existing certification result.

This wave measures whether an external engineer can install and use the public
surface without importing workspace internals. It does not turn PREMiSE into a
database, retrieval engine, embedding system, cloud service, or universal
truth authority.

## Evidence rules

- A local tarball install is reported as a package-publication gate, not as
  proof that the package is available from the public registry.
- A real connector campaign is PASS only when the connector was actually
  reached and its evidence is retained.
- Missing credentials, unavailable infrastructure, or deliberately disabled
  external systems are NOT_RUN.
- Deterministic mocks can test protocol handling, but cannot support claims
  about a third-party service.
- Generated reports live under .tmp/ and are not committed.

## Acceptance gates

1. @premise/sdk builds and packs without workspace dependencies.
2. Three fresh consumer projects are created in an operating-system temporary
   directory, install the SDK tarball with npm, and run without the monorepo or
   a workspace lockfile.
3. The Skill explains the boundary between agent workflow and runtime
   enforcement.
4. The MCP surface exposes only the minimum documented operations.
5. Filesystem, HTTP, and process failure tests run against actual local
   processes and files.
6. PostgreSQL is either executed against POSTGRES_URL or reported
   NOT_RUN.
7. The static Public-Boundary Check rejects private imports and records
   deterministic integration metrics without launching an agent.
8. The standalone plugin gate copies the plugin outside the monorepo and
   launches its MCP through the official MCP `StdioClientTransport` in
   zero-config SELFTEST mode and configured REMOTE mode.
9. The cross-agent install gate copies the standalone kit outside the monorepo,
   installs Codex, Claude Code and generic MCP surfaces, preserves unrelated
   configuration, and proves an installed MCP self-test.
10. The isolated Codex/Luna experiment is a separate opt-in process run; its
   absent or unavailable runner is reported as NOT_RUN, never PASS.
11. CI validates the package gate, certification, standalone plugin, cross-agent
    installer, and the no-internal-import rule.

## Public claims after this wave

The project may claim that the public SDK is installable from a tested local
package artifact when the package gate passes. The isolated fixtures cover
GitHub-like, REST and filesystem consumers outside the checkout; they are
package-boundary fixtures, not proof of live GitHub or third-party adoption.
It may claim real-world certification only for the connectors and failure modes
whose artifacts show PASS. Registry publication, independent external holdout
evaluation and production availability remain separate claims.
