# External integration evidence

The adoption gate deliberately exercises the public SDK outside the repository
workspace. It builds `@premise/sdk`, packs it as a local tarball, creates fresh
consumer directories in the operating system temporary directory, and runs the
same smoke contract in each consumer.

| Fixture | Source boundary exercised | What a passing run proves |
| --- | --- | --- |
| `github-agent` | GitHub-like adapter fixture | The package boundary can support a consumer shaped like a GitHub integration |
| `filesystem-agent` | Local file adapter fixture | A consumer can install and execute without workspace imports |
| `rest-agent` | HTTP/REST adapter fixture | The public SDK can be loaded by a standalone HTTP-shaped consumer |

These fixtures are intentionally deterministic and local. They do not claim a
live GitHub installation, third-party adoption, registry publication, or
PostgreSQL availability. A live connector campaign must be run separately and
must retain its own evidence; missing credentials are `NOT_RUN`, never `PASS`.

Run the gate with:

```bash
pnpm adoption:package-gate
```

The gate removes its temporary consumer directory after the report is printed.
