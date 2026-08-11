import assert from "node:assert/strict";
import test from "node:test";
import { buildReadOnlyQueries, POSTGRES_BENCHMARK_FORMAT, safeSqlIdentifier } from "./postgres.mjs";

test("Postgres connector only accepts a simple identifier", () => {
  assert.equal(safeSqlIdentifier("public.premise_v2_events"), '"public"."premise_v2_events"');
  for (const value of ["public.events; DROP TABLE users", "events WHERE true", "events()", "../events", ""]) {
    assert.throws(() => safeSqlIdentifier(value), /simple schema\.table identifier/u);
  }
});

test("Postgres query pack is read-only and parameterizes the relation probe", () => {
  assert.equal(POSTGRES_BENCHMARK_FORMAT, "premise-v2-postgres-read-only/1");
  const queries = buildReadOnlyQueries("public.premise_v2_events");
  assert.equal(queries.length, 5);
  for (const query of queries) {
    assert.ok(query.id && query.prompt && query.sql, "query metadata is incomplete");
    assert.ok(Array.isArray(query.values), "query values must be explicit");
    assert.doesNotMatch(query.sql, /\b(?:ALTER|CREATE|DELETE|DROP|GRANT|INSERT|TRUNCATE|UPDATE|VACUUM)\b/iu, "benchmark query must not mutate Postgres");
  }
  const relation = queries.find((query) => query.relationProbe);
  assert.equal(relation.sql, "SELECT to_regclass($1) AS relation");
  assert.deepEqual(relation.values, ["public.premise_v2_events"]);
  assert.match(queries.find((query) => query.id === "postgres.event-count").sql, /FROM "public"\."premise_v2_events"/u);
});
