import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = await readFile(new URL("./postgres/postgresql.conf", import.meta.url), "utf8");
const compose = await readFile(new URL("./docker-compose.yml", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
const productionEnv = await readFile(new URL("./config/production.env.example", import.meta.url), "utf8");
const prometheus = await readFile(new URL("./prometheus.yml", import.meta.url), "utf8");

function setting(text, name) {
  const match = text.match(new RegExp(`^\\s*${name}\\s*=\\s*([^\\s#]+)\\s*(?:#.*)?$`, "mu"));
  assert.ok(match, `${name} must be set explicitly`);
  return match[1].replace(/^['"]|['"]$/gu, "");
}

function megabytes(value) {
  const match = value.match(/^(\d+)(MB|GB)$/u);
  assert.ok(match, `expected a WAL size, got ${value}`);
  return Number(match[1]) * (match[2] === "GB" ? 1024 : 1);
}

test("PostgreSQL baseline keeps durable writes and smooths checkpoint/WAL pressure", () => {
  assert.equal(setting(config, "data_directory"), "/var/lib/postgresql/data");
  assert.equal(setting(config, "listen_addresses"), "*");
  assert.match(config, /^include_if_exists ['"]\/var\/lib\/postgresql\/data\/postgresql\.auto\.conf['"]$/mu);
  assert.equal(setting(config, "max_connections"), "64");
  assert.equal(setting(config, "checkpoint_timeout"), "15min");
  assert.equal(setting(config, "checkpoint_completion_target"), "0.9");
  assert.equal(setting(config, "wal_compression"), "pglz");
  assert.equal(setting(config, "fsync"), "on");
  assert.equal(setting(config, "full_page_writes"), "on");
  assert.equal(setting(config, "synchronous_commit"), "on");
  assert.ok(megabytes(setting(config, "max_wal_size")) >= megabytes(setting(config, "min_wal_size")) * 4);
});

test("Compose activates the checked-in config and leaves pool headroom", () => {
  assert.match(compose, /command:\s*\["postgres",\s*"-c",\s*"config_file=\/etc\/postgresql\/postgresql\.conf"\]/u);
  assert.match(compose, /- \.\/postgres\/postgresql\.conf:\/etc\/postgresql\/postgresql\.conf:ro/u);
  assert.equal((compose.match(/^\s+PREMISE_DB_POOL_SIZE:/gmu) ?? []).length, 3);
  const pool = compose.match(/PREMISE_DB_POOL_SIZE:\s*\$\{PREMISE_DB_POOL_SIZE:-(\d+)\}/u)?.[1];
  assert.equal(pool, "8");
  assert.ok(Number(setting(config, "max_connections")) >= Number(pool) + 16);
});

test("Compose provisions and uses a non-bypass RLS application role", () => {
  assert.match(compose, /^\s+db-roles:\s*$/mu);
  assert.match(compose, /CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS/u);
  assert.match(compose, /ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS/u);
  assert.match(compose, /migrate:[\s\S]*?db-roles:\s*\n\s+condition: service_completed_successfully/u);
  assert.match(compose, /DATABASE_URL: \$\{MIGRATIONS_DATABASE_URL:-postgresql:\/\/\$\{POSTGRES_USER:-premise\}/u);
  assert.match(compose, /PREMISE_DB_USER: \$\{PREMISE_DB_USER:-premise_app\}/u);
  const databaseUrls = [...compose.matchAll(/^\s+DATABASE_URL:\s+(.+)$/gmu)].map((match) => match[1]);
  assert.equal(databaseUrls.length, 3);
  assert.ok(databaseUrls.slice(1).every((value) => value.includes("PREMISE_DB_USER") && !value.includes("POSTGRES_USER:-")));
});

test("Prometheus 3.5 receives its bearer through a Docker secret file", () => {
  assert.doesNotMatch(compose, /--config\.expand-env/u);
  assert.match(compose, /premise_metrics_token:\s*\n\s+file:\s+\$\{PREMISE_METRICS_TOKEN_FILE:-\.\.\/\.local\/premise_metrics_token\}/u);
  assert.match(compose, /prometheus:[\s\S]*?secrets:\s*\n\s+- source: premise_metrics_token\s*\n\s+target: premise_metrics_token/u);
  assert.match(prometheus, /bearer_token_file:\s+\/run\/secrets\/premise_metrics_token/u);
  assert.doesNotMatch(prometheus, /PREMISE_METRICS_TOKEN|PREMISE_API_TOKEN/u);
});

test("production example pins the same pool budget", () => {
  assert.match(productionEnv, /^PREMISE_DB_POOL_SIZE=8$/mu);
  assert.match(productionEnv, /^PREMISE_DB_USER=__INJECT_DB_APP_USER__$/mu);
  assert.match(productionEnv, /^PREMISE_METRICS_TOKEN=__INJECT_METRICS_TOKEN__$/mu);
  assert.match(productionEnv, /DATABASE_URL must resolve to the NOSUPERUSER\/NOBYPASSRLS application role/u);
  assert.match(productionEnv, /^MIGRATIONS_DATABASE_URL=__INJECT_MIGRATIONS_FROM_SECRET_MANAGER__$/mu);
});

test("production image carries the in-network soak diagnostic", () => {
  assert.match(dockerfile, /COPY --from=build --chown=10001:10001 \/workspace\/benchmarks\/ga-soak \.\/benchmarks\/ga-soak/u);
});
