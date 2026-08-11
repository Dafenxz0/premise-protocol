# PremiseBench-Agent worlds

The filesystem world is the default smoke world and is fully local. The GitHub and PostgreSQL adapters below are real connector probes, but are opt-in and read-only by default.

| World | Default | Required access | Mutation policy |
| --- | --- | --- | --- |
| filesystem | yes | none | Temporary file only. |
| GitHub | no | `PREMISE_GITHUB_REPO` and token for private data | No mutation implementation in the default adapter. A controlled mutation driver must be injected explicitly. |
| PostgreSQL | no | `DATABASE_URL` and an explicitly named table/row | No schema changes. Writes require an explicit mutation driver. |

Any missing credential, permission, or controlled target is `NOT_RUN`; it is never converted into a passing result.
