# PREMiSE Protocol

Private TypeScript workspace for the PREMiSE protocol and its reference tooling.

## Development bootstrap

The repository targets Node.js 24 and pnpm 10. The package manager is pinned in
the root manifest so local and CI installs use the same toolchain family.

```text
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The package and example directories are intentionally empty scaffolds at this
stage. Their export maps point at future `dist/` artifacts, while each package
has an empty composite TypeScript project so the workspace is installable and
compilable before the implementation waves begin.

Bootstrap deliberately adds no runtime dependencies and does not implement
protocol semantics, validators, adapters, persistence, scenarios, or CI. Those
files remain with the ownerships defined by the PREMiSE plan.
