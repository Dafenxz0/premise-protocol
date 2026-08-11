# Live-world review checklist

The live adapters are designed to prevent a local fixture from being called a real-world campaign.

## GitHub

1. `PREMISE_GITHUB_REPO` identifies the repository and `PREMISE_GITHUB_PATH`/`PREMISE_GITHUB_REF` identify the read target.
2. A token is optional for public data and required for private data; it is read from the process environment only.
3. The default world calls the GitHub contents API and records the ETag or blob SHA as `Version`.
4. It never mutates a repository. A future campaign must inject a mutation driver for a temporary repository or fork and record its target in the manifest.
5. Rate-limit headers, HTTP status, permissions, and the exact ref are recorded. A 401/403/404/rate-limit response is `NOT_RUN` or `UNKNOWN`, never a passing task.

The existing personal repositories can be used for read-only observation campaigns, but not for mutating benchmark tasks without an explicit temporary target.

## PostgreSQL

1. `DATABASE_URL`, a table, row identifier, version column, and payload column are required.
2. Identifiers are allow-listed and values are parameterized. The adapter does not run migrations or create tables.
3. Reads expose the row version as an opaque token. The guarded action uses a transaction and `WHERE id = $id AND version = $observedVersion`.
4. Missing driver, connection, table, row, or permission returns `NOT_RUN`/`UNKNOWN` with the reason.
5. A real campaign must use a disposable schema/row and record cleanup and rollback evidence separately.

## Required live evidence before claims

Live read access proves connector reachability and version observation. It does not prove stale-action prevention. That claim requires a controlled mutation, blind agent process, action result, and an evaluator trace that is not visible to the agent.
