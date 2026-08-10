import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POSTGRES_TELEMETRY_FORMAT = "premise-ga-soak/postgres-telemetry/1";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(3));
}

function firstRow(result, label) {
  const rows = Array.isArray(result) ? result : result?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`PostgreSQL telemetry query returned no ${label} row`);
  return rows[0];
}

async function loadPool() {
  try {
    const module = await import("pg");
    const Pool = module.Pool ?? module.default?.Pool;
    if (typeof Pool === "function") return Pool;
  } catch {
    // The repository keeps pg in the deployment dependency set, not the root workspace.
  }

  try {
    const deploymentRequire = createRequire(path.join(REPOSITORY_ROOT, "deploy", "package.json"));
    const module = deploymentRequire("pg");
    const Pool = module.Pool ?? module.default?.Pool;
    if (typeof Pool === "function") return Pool;
  } catch {
    // Report the actionable error below instead of leaking a module-resolution stack.
  }

  throw new Error("PostgreSQL telemetry requires the existing pg driver; run npm ci in deploy/ or execute the check in the PREMiSE deployment image");
}

export function databaseUrl(environment = process.env) {
  return environment.PREMISE_SOAK_DATABASE_URL ?? environment.DATABASE_URL ?? environment.POSTGRES_URL;
}

export async function openPostgresTelemetry({ connectionString = databaseUrl() } = {}) {
  if (typeof connectionString !== "string" || connectionString.length === 0 || connectionString.startsWith("__")) {
    throw new Error("Set PREMISE_SOAK_DATABASE_URL, DATABASE_URL, or POSTGRES_URL for PostgreSQL telemetry");
  }

  const Pool = await loadPool();
  const pool = new Pool({ connectionString, max: 1, application_name: "premise-ga-soak" });
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    snapshot: () => readPostgresTelemetry((sql) => pool.query(sql)),
    close: () => pool.end()
  };
}

export async function readPostgresTelemetry(query, capturedAt = new Date()) {
  const metadata = firstRow(await query(`
    SELECT
      current_database() AS database,
      current_setting('server_version_num')::int AS server_version_num,
      current_setting('max_connections')::int AS max_connections,
      (to_regclass('pg_catalog.pg_stat_checkpointer') IS NOT NULL) AS has_checkpointer,
      (to_regclass('pg_catalog.pg_stat_wal') IS NOT NULL) AS has_wal
  `), "metadata");
  if (metadata.has_wal !== true) throw new Error("PostgreSQL pg_stat_wal is unavailable; use PostgreSQL 14 or newer for WAL telemetry");

  const checkpointView = metadata.has_checkpointer === true ? "pg_stat_checkpointer" : "pg_stat_bgwriter";
  const checkpointSql = checkpointView === "pg_stat_checkpointer"
    ? `
      SELECT
        num_timed AS checkpoints_timed,
        num_requested AS checkpoints_req,
        num_done AS checkpoints_done,
        write_time AS checkpoint_write_time,
        sync_time AS checkpoint_sync_time,
        buffers_written AS buffers_checkpoint,
        stats_reset
      FROM pg_catalog.pg_stat_checkpointer
    `
    : `
      SELECT
        checkpoints_timed,
        checkpoints_req,
        NULL::bigint AS checkpoints_done,
        checkpoint_write_time,
        checkpoint_sync_time,
        buffers_checkpoint,
        stats_reset
      FROM pg_catalog.pg_stat_bgwriter
    `;

  const [checkpointResult, walResult, databaseResult, connectionResult] = await Promise.all([
    query(checkpointSql),
    query(`
      SELECT
        wal_records,
        wal_fpi,
        wal_bytes,
        wal_buffers_full,
        wal_write,
        wal_sync,
        wal_write_time,
        wal_sync_time,
        stats_reset
      FROM pg_catalog.pg_stat_wal
    `),
    query(`
      SELECT
        xact_commit,
        xact_rollback,
        blks_read,
        blks_hit,
        tup_returned,
        tup_fetched,
        tup_inserted,
        tup_updated,
        tup_deleted,
        temp_files,
        temp_bytes,
        deadlocks,
        stats_reset
      FROM pg_catalog.pg_stat_database
      WHERE datname = current_database()
    `),
    query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE state = 'active')::int AS active,
        count(*) FILTER (WHERE state = 'idle')::int AS idle,
        count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_transaction,
        count(*) FILTER (WHERE wait_event_type IS NOT NULL)::int AS waiting
      FROM pg_catalog.pg_stat_activity
    `)
  ]);

  const checkpoint = firstRow(checkpointResult, "checkpoint");
  const wal = firstRow(walResult, "WAL");
  const database = firstRow(databaseResult, "database");
  const connections = firstRow(connectionResult, "connection");
  const timestamp = new Date(capturedAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error("PostgreSQL telemetry capture time is invalid");

  return {
    format: POSTGRES_TELEMETRY_FORMAT,
    capturedAt: timestamp.toISOString(),
    database: String(metadata.database ?? "unknown"),
    serverVersionNum: numeric(metadata.server_version_num),
    checkpoint: {
      view: checkpointView,
      timed: numeric(checkpoint.checkpoints_timed),
      requested: numeric(checkpoint.checkpoints_req),
      completed: numeric(checkpoint.checkpoints_done),
      writeTimeMs: numeric(checkpoint.checkpoint_write_time),
      syncTimeMs: numeric(checkpoint.checkpoint_sync_time),
      buffers: numeric(checkpoint.buffers_checkpoint),
      statsResetAt: checkpoint.stats_reset ?? null
    },
    wal: {
      records: numeric(wal.wal_records),
      fpi: numeric(wal.wal_fpi),
      bytes: numeric(wal.wal_bytes),
      buffersFull: numeric(wal.wal_buffers_full),
      writes: numeric(wal.wal_write),
      syncs: numeric(wal.wal_sync),
      writeTimeMs: numeric(wal.wal_write_time),
      syncTimeMs: numeric(wal.wal_sync_time),
      statsResetAt: wal.stats_reset ?? null
    },
    databaseStats: {
      commits: numeric(database.xact_commit),
      rollbacks: numeric(database.xact_rollback),
      blocksRead: numeric(database.blks_read),
      blocksHit: numeric(database.blks_hit),
      tuplesReturned: numeric(database.tup_returned),
      tuplesFetched: numeric(database.tup_fetched),
      tuplesInserted: numeric(database.tup_inserted),
      tuplesUpdated: numeric(database.tup_updated),
      tuplesDeleted: numeric(database.tup_deleted),
      tempFiles: numeric(database.temp_files),
      tempBytes: numeric(database.temp_bytes),
      deadlocks: numeric(database.deadlocks),
      statsResetAt: database.stats_reset ?? null
    },
    connections: {
      max: numeric(metadata.max_connections),
      total: numeric(connections.total),
      active: numeric(connections.active),
      idle: numeric(connections.idle),
      idleInTransaction: numeric(connections.idle_in_transaction),
      waiting: numeric(connections.waiting)
    }
  };
}

function delta(start, end, resetDetected) {
  if (resetDetected || start === null || end === null || start === undefined || end === undefined) return null;
  const value = end - start;
  return Number.isFinite(value) && value >= 0 ? rounded(value) : null;
}

function sum(left, right) {
  return left === null || right === null ? null : rounded(left + right);
}

function resetChanged(start, end) {
  return start !== null && end !== null && start !== undefined && end !== undefined && String(start) !== String(end);
}

function deltaFields(start, end, fields, resetDetected) {
  return Object.fromEntries(fields.map((field) => [field, delta(start[field], end[field], resetDetected)]));
}

export function diffPostgresTelemetry(start, end, elapsedMs) {
  if (!start || !end) return { available: false, reason: "two PostgreSQL telemetry samples are required" };
  const elapsed = numeric(elapsedMs);
  const windowMs = elapsed !== null && elapsed > 0 ? elapsed : 0;
  const checkpointReset = resetChanged(start.checkpoint.statsResetAt, end.checkpoint.statsResetAt);
  const walReset = resetChanged(start.wal.statsResetAt, end.wal.statsResetAt);
  const databaseReset = resetChanged(start.databaseStats.statsResetAt, end.databaseStats.statsResetAt);
  const checkpoint = deltaFields(start.checkpoint, end.checkpoint, ["timed", "requested", "completed", "writeTimeMs", "syncTimeMs", "buffers"], checkpointReset);
  const wal = deltaFields(start.wal, end.wal, ["records", "fpi", "bytes", "buffersFull", "writes", "syncs", "writeTimeMs", "syncTimeMs"], walReset);
  const database = deltaFields(start.databaseStats, end.databaseStats, ["commits", "rollbacks", "blocksRead", "blocksHit", "tuplesReturned", "tuplesFetched", "tuplesInserted", "tuplesUpdated", "tuplesDeleted", "tempFiles", "tempBytes", "deadlocks"], databaseReset);
  const checkpointTotal = checkpoint.completed ?? sum(checkpoint.timed, checkpoint.requested);
  const checkpointTime = sum(checkpoint.writeTimeMs, checkpoint.syncTimeMs);

  return {
    available: true,
    elapsedMs: rounded(windowMs),
    statsResetDetected: checkpointReset || walReset || databaseReset,
    checkpoint: {
      timed: checkpoint.timed,
      requested: checkpoint.requested,
      completed: checkpoint.completed,
      total: checkpointTotal,
      writeTimeMs: checkpoint.writeTimeMs,
      syncTimeMs: checkpoint.syncTimeMs,
      totalTimeMs: checkpointTime,
      buffers: checkpoint.buffers,
      timeShareOfWindow: checkpointTime === null || windowMs === 0 ? null : rounded(checkpointTime / windowMs),
      requestedShare: checkpointTotal === null || checkpointTotal === 0 || checkpoint.requested === null ? null : rounded(checkpoint.requested / checkpointTotal)
    },
    wal: {
      records: wal.records,
      fpi: wal.fpi,
      bytes: wal.bytes,
      buffersFull: wal.buffersFull,
      writes: wal.writes,
      syncs: wal.syncs,
      writeTimeMs: wal.writeTimeMs,
      syncTimeMs: wal.syncTimeMs
    },
    database: {
      commits: database.commits,
      rollbacks: database.rollbacks,
      blocksRead: database.blocksRead,
      blocksHit: database.blocksHit,
      tuplesReturned: database.tuplesReturned,
      tuplesFetched: database.tuplesFetched,
      tuplesInserted: database.tuplesInserted,
      tuplesUpdated: database.tuplesUpdated,
      tuplesDeleted: database.tuplesDeleted,
      tempFiles: database.tempFiles,
      tempBytes: database.tempBytes,
      deadlocks: database.deadlocks
    },
    connections: {
      start: start.connections,
      end: end.connections,
      max: end.connections.max
    }
  };
}

function peakConnections(samples) {
  const fields = ["max", "total", "active", "idle", "idleInTransaction", "waiting"];
  return Object.fromEntries(fields.map((field) => {
    const values = samples.map((sample) => numeric(sample.connections?.[field])).filter((value) => value !== null);
    return [field, values.length === 0 ? null : Math.max(...values)];
  }));
}

export function summarizePostgresTelemetry(samples, elapsedMs) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return { available: false, reason: "two PostgreSQL telemetry samples are required", sampleCount: Array.isArray(samples) ? samples.length : 0 };
  }
  const deltaResult = diffPostgresTelemetry(samples[0], samples[samples.length - 1], elapsedMs);
  const peak = peakConnections(samples);
  const connectionMax = peak.max ?? deltaResult.connections.max;
  const connectionUtilization = connectionMax === null || connectionMax === 0 || peak.total === null ? null : rounded(peak.total / connectionMax);
  return {
    ...deltaResult,
    sampleCount: samples.length,
    connections: {
      ...deltaResult.connections,
      peak,
      peakUtilization: connectionUtilization
    }
  };
}
