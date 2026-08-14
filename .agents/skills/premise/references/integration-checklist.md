# External integration checklist

Use this checklist when an agent integrates PREMiSE into a project that is not
the PREMiSE monorepo.

1. Use Node 24 and an ordinary npm or pnpm project.
2. Install @premise/sdk from the registry or the release tarball.
3. Confirm that the project has no pnpm-workspace.yaml, workspace protocol
   dependency, or import from an internal PREMiSE package.
4. Configure the base URL and tenant explicitly. Keep tokens in environment
   variables.
5. Call health or capabilities and verify the premise/2 contract.
6. Observe or query the source, retain the version and evidence identity, and
   revalidate immediately before a consequential action.
7. Use an idempotency key for every conditional write and retain its receipt.
8. Record connector availability and skipped tests in the report.

The local adoption gate copies a consumer into a clean temporary directory,
installs the SDK tarball with npm, and executes its smoke script. Passing this
gate proves package isolation and API compatibility, not a public registry
release or a third-party service guarantee.
