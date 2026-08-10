import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = await readFile(new URL("./postgres/postgresql.conf", import.meta.url), "utf8");
const compose = await readFile(new URL("./docker-compose.yml", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
const productionEnv = await readFile(new URL("./config/production.env.example", import.meta.url), "utf8");

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

test("production example pins the same pool budget", () => {
  assert.match(productionEnv, /^PREMISE_DB_POOL_SIZE=8$/mu);
});

test("production image carries the in-network soak diagnostic", () => {
  assert.match(dockerfile, /COPY --from=build --chown=10001:10001 \/workspace\/benchmarks\/ga-soak \.\/benchmarks\/ga-soak/u);
});
