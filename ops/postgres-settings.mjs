import { openPgClient } from "./pg-client.mjs";

export const POSTGRES_SETTINGS_FORMAT = "premise-postgres-settings/1";

export const REQUIRED_SETTINGS = Object.freeze({
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
});

function text(value) {
  return value === null || value === undefined ? null : String(value);
}

export function normalizeSettings(rows) {
  return rows.map((row) => ({
    name: text(row.name),
    setting: text(row.setting),
    unit: text(row.unit),
    sourcefile: text(row.sourcefile),
    pendingRestart: row.pending_restart === true || row.pending_restart === "t"
  }));
}

export function validateSettings(settings, expected = REQUIRED_SETTINGS) {
  const byName = new Map(settings.map((setting) => [setting.name, setting]));
  const failures = [];
  for (const [name, expectedValue] of Object.entries(expected)) {
    const observed = byName.get(name);
    if (observed === undefined) {
      failures.push({ name, code: "missing", expected: expectedValue });
      continue;
    }
    if (observed.setting !== expectedValue) failures.push({ name, code: "value-mismatch", expected: expectedValue, observed: observed.setting });
    if (observed.pendingRestart) failures.push({ name, code: "pending-restart", expected: false, observed: true });
  }
  return { passed: failures.length === 0, failures };
}

export async function readEffectiveSettings(client) {
  const names = Object.keys(REQUIRED_SETTINGS);
  const result = await client.query(`
    SELECT name, setting, unit, sourcefile, pending_restart
    FROM pg_catalog.pg_settings
    WHERE name = ANY($1::text[])
    ORDER BY name
  `, [names]);
  return normalizeSettings(result.rows);
}

async function main() {
  const client = await openPgClient();
  try {
    const settings = await readEffectiveSettings(client);
    const validation = validateSettings(settings);
    const result = {
      schema: POSTGRES_SETTINGS_FORMAT,
      format: POSTGRES_SETTINGS_FORMAT,
      generatedAt: new Date().toISOString(),
      commit: process.env.PREMISE_COMMIT ?? process.env.GITHUB_SHA ?? null,
      source: "pg_settings",
      trace: { database: "runtime DATABASE_URL", names: Object.keys(REQUIRED_SETTINGS) },
      settings,
      validation
    };
    console.log(JSON.stringify(result, null, 2));
    if (!validation.passed) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("postgres-settings.mjs");
if (isMain) main().catch((error) => {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
});
