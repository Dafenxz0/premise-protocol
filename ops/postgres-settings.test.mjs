import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSettings, validateSettings } from "./postgres-settings.mjs";

const names = {
  listen_addresses: "*",
  max_connections: "64",
  checkpoint_timeout: "900",
  checkpoint_completion_target: "0.9",
  max_wal_size: "2048",
  min_wal_size: "256",
  wal_compression: "pglz",
  fsync: "on",
  full_page_writes: "on",
  synchronous_commit: "on"
};

test("normalizes and accepts the checked-in effective PostgreSQL baseline", () => {
  const rows = Object.entries(names).map(([name, setting]) => ({ name, setting, unit: null, sourcefile: "/etc/postgresql/postgresql.conf", pending_restart: false }));
  const settings = normalizeSettings(rows);
  assert.deepEqual(validateSettings(settings), { passed: true, failures: [] });
});

test("rejects an overridden or pending PostgreSQL setting", () => {
  const rows = Object.entries(names).map(([name, setting]) => ({ name, setting, unit: null, sourcefile: "/etc/postgresql/postgresql.conf", pending_restart: false }));
  rows.find((row) => row.name === "max_wal_size").setting = "1024";
  rows.find((row) => row.name === "fsync").pending_restart = true;
  const failures = validateSettings(normalizeSettings(rows)).failures;
  assert.deepEqual(failures.map(({ name, code }) => ({ name, code })), [
    { name: "max_wal_size", code: "value-mismatch" },
    { name: "fsync", code: "pending-restart" }
  ]);
});
