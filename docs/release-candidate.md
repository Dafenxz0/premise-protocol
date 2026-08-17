# PREMiSE 2 release candidate

PREMiSE 2 is the current candidate protocol. The public HTTP contract is
`premise/2`; the TypeScript client candidate is `@premise/sdk@2.0.0-rc.2` and
the repository is licensed under Apache-2.0.

## Recommended installation

From the project where an agent will work:

```bash
npx --yes --package github:Dafenxz0/premise-protocol#main premise-install --agent all --project .
```

The installer is dependency-free and defaults to `SELFTEST`. Remote mode is
opt-in through `PREMISE_MODE=REMOTE` and `PREMISE_BASE_URL`; credentials belong
only in the process environment.

## Release checks

Run these checks from a Node 24/pnpm 10 checkout:

```bash
pnpm release:check
pnpm release:sbom
pnpm adoption:package-gate
pnpm adoption:plugin-install-gate
pnpm adoption:agent-install-gate
```

`release:sbom` writes a CycloneDX report under `.tmp/release/`. The adoption
package gate creates consumers in the operating-system temporary directory,
installs a local SDK tarball with npm and removes those consumers after the
run. It does not claim npm registry publication.

## Evidence boundary

The isolated GitHub-like, REST and filesystem consumers prove package-boundary
compatibility outside the monorepo. They are deterministic fixtures, not live
third-party adoption or a live GitHub/PostgreSQL availability claim.

`premise/1` and `premise/1.1` remain frozen compatibility contracts. PREMiSE
NEXT remains experimental. The candidate is not a universal GA or production
security certification; claims must stay tied to passing, reproducible evidence.
