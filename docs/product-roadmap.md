# Product roadmap: PREMiSE change control

This roadmap is an evidence plan, not a promise of a universal GA release. Each
stage is allowed to ship only when its acceptance evidence is reproducible.

## Days 0–30 — one clear path

- Keep `PremiseSession.prepareAction()` and `guardedWrite()` as the public golden
  path.
- Keep the adapter contract small: observe, revalidate and conditional action.
- Make the HTTP/ETag example, PostgreSQL CAS example and GitHub read/version
  example copyable from the docs.
- Run the static Agent Change Control demo in every documentation review.
- Publish negative results and do not turn deterministic smoke tests into
  production claims.

**Exit evidence:** a new user can install the portable kit, understand the
observe → reason → check → commit flow, and reproduce a stale-write block without
the monorepo's private internals.

## Days 31–60 — durable connector evidence

- Run PostgreSQL with a real service, multiple processes and deliberate restarts.
- Test row-version/CAS conflicts, transaction rollback, idempotent replay and
  tenant isolation under concurrent writers.
- Test HTTP ETag conflicts against a controlled server and record latency/error
  classes.
- Test GitHub against a disposable repository or fork with least-privilege
  credentials; never mutate a personal repository without explicit authorization.
- Add backups, restore verification and rollback evidence to the deployment
  notes.

**Exit evidence:** every connector has a documented atomic boundary, a failure
  matrix and a reproducible report. Missing credentials or services remain
  `NOT_RUN`, never `PASS`.

## Days 61–90 — adoption and release decision

- Verify the standalone Codex/Claude/MCP installation in clean environments.
- Run isolated agent experiments with the same tasks, source changes and policy
  for every arm; keep the evaluator blind to the arm identity.
- Measure safe completions, stale actions blocked, re-observations, tool calls,
  latency and cost per safe completion.
- Publish a threat model, security response process, SBOM and selected license.
- Review the public README against generated evidence and remove unsupported
  claims.

**Exit evidence:** the team can say exactly where PREMiSE helps, where it costs
more, and where it has not been tested. Only then decide whether this candidate is
ready for a production release.

## Explicitly deferred

Retrieval, embeddings, vector databases, universal memory, extra protocol variants,
new cloud services and large connector collections are deferred until the change
control primitive has durable external evidence. The product should become easier
to trust before it becomes larger.
