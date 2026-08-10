import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";

const FORMAT = "premise-v2-backup";
const VERSION = 1;
export const STREAM_FORMAT = "premise-v2-backup-ndjson";
export const STREAM_VERSION = 1;
const ENTRY_KINDS = ["record", "event", "snapshot", "checkpoint", "http_idempotency"];
const ENTRY_ORDER = new Map(ENTRY_KINDS.map((kind, index) => [kind, index]));
const COUNT_FIELDS = ["records", "events", "snapshots", "checkpoints", "httpIdempotency"];

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("PREMiSE backup values must be JSON serializable");
  return serialized;
}

export function createBackup(snapshot) {
  const payload = { format: FORMAT, version: VERSION, snapshot };
  return { ...payload, sha256: digest(payload) };
}

export function parseBackup(value) {
  if (value === null || typeof value !== "object" || value.format !== FORMAT || value.version !== VERSION || value.snapshot === undefined || typeof value.sha256 !== "string") throw new Error("Unsupported PREMiSE backup format");
  const payload = { format: value.format, version: value.version, snapshot: value.snapshot };
  if (digest(payload) !== value.sha256) throw new Error("PREMiSE backup checksum mismatch");
  if (value.snapshot.format !== "premise-runtime-snapshot" || value.snapshot.version !== 1 || !Array.isArray(value.snapshot.records) || !Array.isArray(value.snapshot.events)) throw new Error("PREMiSE backup snapshot is invalid");
  return value.snapshot;
}

function assertDateTime(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be an ISO date-time`);
}

function normalizedDateTime(value, label) {
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) throw new TypeError(`${label} must be an ISO date-time`);
    return value.toISOString();
  }
  assertDateTime(value, label);
  return value;
}

function assertCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`PREMiSE backup ${label} is invalid`);
}

function assertSequence(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`PREMiSE backup ${label} is invalid`);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`PREMiSE backup ${label} is invalid`);
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`PREMiSE backup ${label} is invalid`);
}

function parseJson(value, label, allowNull = false) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`PREMiSE backup ${label} contains invalid JSON`, { cause: error });
    }
  }
  if (value === undefined || (!allowNull && value === null)) throw new Error(`PREMiSE backup ${label} is invalid`);
  return value;
}

function jsonText(value, label) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`PREMiSE backup ${label} must be JSON serializable`);
  return serialized;
}

function streamHeader(metadata) {
  if (metadata === null || typeof metadata !== "object") throw new TypeError("NDJSON backup metadata is required");
  const capturedAt = metadata.capturedAt ?? new Date().toISOString();
  const tenantId = metadata.tenantId;
  assertDateTime(capturedAt, "backup capturedAt");
  if (typeof tenantId !== "string" || tenantId.length === 0 || tenantId.trim() !== tenantId) throw new TypeError("backup tenantId must be a non-empty string without surrounding whitespace");
  return { format: STREAM_FORMAT, version: STREAM_VERSION, capturedAt, tenantId };
}

function dataLine(kind, value, metadata = {}) {
  if (!ENTRY_ORDER.has(kind)) throw new TypeError(`Unsupported NDJSON backup entry kind: ${kind}`);
  return `${canonicalJson({ kind, value, ...metadata })}\n`;
}

function emptyCounts() {
  return { records: 0, events: 0, snapshots: 0, checkpoints: 0, httpIdempotency: 0 };
}

function countField(kind) {
  return kind === "http_idempotency" ? "httpIdempotency" : `${kind}s`;
}

function assertEntryTenant(kind, value, tenantId) {
  const entryTenant = kind === "record" ? value?.envelope?.tenantId : value?.tenantId;
  if (kind === "snapshot") {
    if (entryTenant !== tenantId && entryTenant !== "__all__") throw new Error(`PREMiSE backup ${kind} tenant does not match the backup header`);
    return;
  }
  if (entryTenant !== tenantId) throw new Error(`PREMiSE backup ${kind} tenant does not match the backup header`);
}

function validateEntry(kind, value, tenantId) {
  assertObject(value, kind);
  assertEntryTenant(kind, value, tenantId);
  if (kind === "record") {
    assertObject(value.envelope, "record.envelope");
    assertString(value.envelope.memoryId, "record.envelope.memoryId");
    return;
  }
  if (kind === "event") {
    assertString(value.eventId, "event.eventId");
    assertString(value.idempotencyKey, "event.idempotencyKey");
    if (value.occurredAt !== undefined) assertDateTime(value.occurredAt, "event.occurredAt");
    return;
  }
  if (kind === "snapshot") {
    assertString(value.snapshotId, "snapshot.snapshotId");
    assertDateTime(value.capturedAt, "snapshot.capturedAt");
    if (value.createdAt !== undefined) assertDateTime(value.createdAt, "snapshot.createdAt");
    assertObject(value.snapshot, "snapshot.snapshot");
    if (value.snapshot.format !== "premise-runtime-snapshot" || value.snapshot.version !== 1 || !Array.isArray(value.snapshot.records) || !Array.isArray(value.snapshot.events)) throw new Error("PREMiSE backup snapshot.snapshot is invalid");
    assertDateTime(value.snapshot.capturedAt, "snapshot.snapshot.capturedAt");
    if (Date.parse(value.snapshot.capturedAt) !== Date.parse(value.capturedAt)) throw new Error("PREMiSE backup snapshot capturedAt does not match its row");
    return;
  }
  if (kind === "checkpoint") {
    assertString(value.consumerId, "checkpoint.consumerId");
    assertSequence(value.eventSequence, "checkpoint.eventSequence");
    if (value.updatedAt !== undefined) assertDateTime(value.updatedAt, "checkpoint.updatedAt");
    return;
  }
  assertString(value.operation, "http idempotency.operation");
  assertString(value.idempotencyKey, "http idempotency.idempotencyKey");
  assertString(value.requestHash, "http idempotency.requestHash");
  assertString(value.state, "http idempotency.state");
  assertString(value.leaseToken, "http idempotency.leaseToken");
  if (value.state !== "IN_PROGRESS" && value.state !== "COMPLETED") throw new Error("PREMiSE backup http idempotency.state is invalid");
  if (value.statusCode !== null && value.statusCode !== undefined) assertSequence(value.statusCode, "http idempotency.statusCode", 100);
  if (value.statusCode !== null && value.statusCode !== undefined && value.statusCode > 599) throw new Error("PREMiSE backup http idempotency.statusCode is invalid");
  if (value.state === "IN_PROGRESS" && (value.statusCode !== null && value.statusCode !== undefined || value.response !== null && value.response !== undefined)) throw new Error("PREMiSE backup in-progress HTTP idempotency row must not contain a response");
  if (value.state === "COMPLETED" && (value.statusCode === null || value.statusCode === undefined || value.response === undefined)) throw new Error("PREMiSE backup completed HTTP idempotency row is incomplete");
  if (value.responseHeaders !== undefined) {
    assertObject(value.responseHeaders, "http idempotency.responseHeaders");
    for (const [key, header] of Object.entries(value.responseHeaders)) if (typeof header !== "string") throw new Error(`PREMiSE backup HTTP idempotency header ${key} is invalid`);
  }
  if (value.createdAt !== undefined) assertDateTime(value.createdAt, "http idempotency.createdAt");
  if (value.updatedAt !== undefined) assertDateTime(value.updatedAt, "http idempotency.updatedAt");
}

export function createIncrementalDigest() {
  const hash = createHash("sha256");
  const counts = emptyCounts();
  let eventsWithSequence = 0;
  let eventSequenceMode;
  let complete = false;

  function add(kind, value, metadata = {}) {
    if (complete) throw new Error("PREMiSE backup digest is already finalized");
    hash.update(dataLine(kind, value, metadata), "utf8");
    counts[countField(kind)] += 1;
    if (kind === "event") {
      const mode = metadata.sequence === undefined ? "implicit" : "explicit";
      if (eventSequenceMode !== undefined && eventSequenceMode !== mode) throw new Error("PREMiSE backup event sequence metadata is inconsistent");
      eventSequenceMode = mode;
      if (metadata.sequence !== undefined) eventsWithSequence += 1;
    }
  }

  return {
    addRecord(value) { add("record", value); },
    addEvent(value, sequence) { add("event", value, sequence === undefined ? {} : { sequence }); },
    addSnapshot(value) { add("snapshot", value); },
    addCheckpoint(value) { add("checkpoint", value); },
    addHttpIdempotency(value) { add("http_idempotency", value); },
    finish(options = {}) {
      if (complete) throw new Error("PREMiSE backup digest is already finalized");
      complete = true;
      const summary = { records: counts.records, events: counts.events, sha256: hash.digest("hex") };
      return options.extended === true
        ? { ...counts, eventSequences: counts.events === 0 || eventsWithSequence === counts.events, sha256: summary.sha256 }
        : summary;
    }
  };
}

function writeLine(stream, line) {
  const chunk = `${line}\n`;
  return new Promise((resolve, reject) => {
    let callbackDone = false;
    let drained = true;
    let settled = false;

    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };
    const settle = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined || error === null) resolve();
      else reject(error);
    };
    const onError = (error) => settle(error);
    const onDrain = () => {
      drained = true;
      if (callbackDone) settle();
    };
    const onWrite = (error) => {
      if (error !== undefined && error !== null) {
        settle(error);
        return;
      }
      callbackDone = true;
      if (drained) settle();
    };

    stream.once("error", onError);
    try {
      drained = stream.write(chunk, "utf8", onWrite);
      if (!drained) stream.once("drain", onDrain);
    } catch (error) {
      settle(error);
    }
  });
}

export function createIncrementalBackupWriter(stream, metadata) {
  if (stream === null || typeof stream !== "object" || typeof stream.write !== "function") throw new TypeError("NDJSON backup writer requires a writable stream");
  const header = streamHeader(metadata);
  const digest = createIncrementalDigest();
  let failure;
  let closed = false;
  let tail = Promise.resolve();

  const onStreamError = (error) => { failure ??= error; };
  stream.on("error", onStreamError);

  function enqueue(action) {
    if (closed) return Promise.reject(new Error("NDJSON backup writer is closed"));
    const task = tail.then(() => {
      if (failure !== undefined) throw failure;
      return action();
    });
    tail = task.catch((error) => {
      failure ??= error;
      throw error;
    });
    return task;
  }

  function writeEntry(kind, value, metadata = {}) {
    return enqueue(async () => {
      validateEntry(kind, value, header.tenantId);
      if (kind === "event" && metadata.sequence !== undefined) assertSequence(metadata.sequence, "event.sequence", 1);
      digest[`add${kind === "http_idempotency" ? "HttpIdempotency" : kind[0].toUpperCase() + kind.slice(1)}`](value, metadata.sequence);
      await writeLine(stream, dataLine(kind, value, metadata).trimEnd());
    });
  }

  const ready = enqueue(() => writeLine(stream, canonicalJson(header)));
  return {
    ready,
    writeRecord(value) { return writeEntry("record", value); },
    writeEvent(value, sequence) { return writeEntry("event", value, sequence === undefined ? {} : { sequence }); },
    writeSnapshot(value) { return writeEntry("snapshot", value); },
    writeCheckpoint(value) { return writeEntry("checkpoint", value); },
    writeHttpIdempotency(value) { return writeEntry("http_idempotency", value); },
    finish() {
      return enqueue(async () => {
        const summary = digest.finish({ extended: true });
        await writeLine(stream, canonicalJson({ kind: "footer", ...summary }));
        closed = true;
        stream.off("error", onStreamError);
        stream.end();
        await finished(stream, { cleanup: true });
        return { ...header, ...summary };
      });
    },
    async abort() {
      closed = true;
      stream.destroy();
      await finished(stream, { cleanup: true }).catch(() => undefined);
      stream.off("error", onStreamError);
    }
  };
}

export function parseBackupBatchSize(value = process.env.PREMISE_BACKUP_BATCH_SIZE) {
  if (value === undefined) return undefined;
  const result = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(result) || result < 1 || result > 10_000) throw new TypeError("PREMISE_BACKUP_BATCH_SIZE must be an integer from 1 to 10000");
  return result;
}

function footerSummary(value) {
  assertObject(value, "footer");
  const summary = emptyCounts();
  for (const field of COUNT_FIELDS) {
    const legacyField = field === "httpIdempotency" ? "idempotency" : field;
    if (value[field] === undefined && value[legacyField] === undefined) {
      if (field === "records" || field === "events") throw new Error(`PREMiSE backup footer.${field} is invalid`);
      continue;
    }
    const count = value[field] ?? value[legacyField];
    assertCount(count, `footer.${field}`);
    summary[field] = count;
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) throw new Error("PREMiSE backup footer sha256 is invalid");
  if (value.eventSequences !== undefined && typeof value.eventSequences !== "boolean") throw new Error("PREMiSE backup footer eventSequences is invalid");
  return { ...summary, sha256: value.sha256, eventSequences: value.eventSequences };
}

function compareSummary(expected, actual) {
  for (const field of COUNT_FIELDS) if (expected[field] !== actual[field]) return false;
  if (expected.sha256 !== actual.sha256) return false;
  if (expected.eventSequences !== undefined && expected.eventSequences !== actual.eventSequences) return false;
  return true;
}

export async function inspectBackupFile(file) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let firstLine;
  try {
    for await (const line of lines) {
      firstLine = line;
      break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (firstLine === undefined || firstLine.trim().length === 0) throw new Error("PREMiSE backup is empty");
  try {
    const value = JSON.parse(firstLine);
    if (value?.format === STREAM_FORMAT) {
      const header = streamHeader(value);
      if (value.version !== STREAM_VERSION) throw new Error("Unsupported PREMiSE NDJSON backup version");
      return { kind: "ndjson", header };
    }
  } catch (error) {
    if (error?.message === "Unsupported PREMiSE NDJSON backup version") throw error;
  }
  return { kind: "legacy" };
}

export async function readIncrementalBackup(file, options = {}) {
  const callbacks = {
    onRecord: options.onRecord ?? (() => undefined),
    onEvent: options.onEvent ?? (() => undefined),
    onSnapshot: options.onSnapshot ?? (() => undefined),
    onCheckpoint: options.onCheckpoint ?? (() => undefined),
    onHttpIdempotency: options.onHttpIdempotency ?? (() => undefined)
  };
  if (Object.values(callbacks).some((callback) => typeof callback !== "function")) throw new TypeError("NDJSON backup readers require function callbacks");
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const digest = createIncrementalDigest();
  let lineNumber = 0;
  let header;
  let footer;
  let phase = -1;
  let lastEventSequence;
  try {
    for await (const rawLine of lines) {
      lineNumber += 1;
      if (rawLine.trim().length === 0) throw new Error(`PREMiSE NDJSON backup has an empty line at ${lineNumber}`);
      let value;
      try {
        value = JSON.parse(rawLine);
      } catch (error) {
        throw new Error(`PREMiSE NDJSON backup has invalid JSON at line ${lineNumber}`, { cause: error });
      }
      if (lineNumber === 1) {
        header = streamHeader(value);
        if (value.version !== STREAM_VERSION) throw new Error("Unsupported PREMiSE NDJSON backup version");
        if (options.expectedTenantId !== undefined && header.tenantId !== options.expectedTenantId) throw new Error("PREMiSE backup tenant does not match the restore target");
        continue;
      }
      if (header === undefined) throw new Error("PREMiSE NDJSON backup header is missing");
      if (footer !== undefined) throw new Error(`PREMiSE NDJSON backup has data after its footer at line ${lineNumber}`);
      if (value?.kind === "footer") {
        footer = footerSummary(value);
        continue;
      }
      const kind = value?.kind;
      if (!ENTRY_ORDER.has(kind)) throw new Error(`PREMiSE NDJSON backup has an unsupported entry at line ${lineNumber}`);
      const entryPhase = ENTRY_ORDER.get(kind);
      if (entryPhase < phase) throw new Error(`PREMiSE NDJSON backup ${kind} appears out of order at line ${lineNumber}`);
      phase = entryPhase;
      validateEntry(kind, value.value, header.tenantId);
      if (kind === "event") {
        if (value.sequence !== undefined) {
          assertSequence(value.sequence, "event.sequence", 1);
          if (lastEventSequence !== undefined && value.sequence <= lastEventSequence) throw new Error("PREMiSE NDJSON backup event sequences are not strictly increasing");
          lastEventSequence = value.sequence;
        }
        await callbacks.onEvent(value.value, value.sequence);
        digest.addEvent(value.value, value.sequence);
      } else if (kind === "record") {
        await callbacks.onRecord(value.value);
        digest.addRecord(value.value);
      } else if (kind === "snapshot") {
        await callbacks.onSnapshot(value.value);
        digest.addSnapshot(value.value);
      } else if (kind === "checkpoint") {
        await callbacks.onCheckpoint(value.value);
        digest.addCheckpoint(value.value);
      } else {
        await callbacks.onHttpIdempotency(value.value);
        digest.addHttpIdempotency(value.value);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (header === undefined) throw new Error("PREMiSE NDJSON backup header is missing");
  if (footer === undefined) throw new Error("PREMiSE NDJSON backup footer is missing");
  const summary = digest.finish({ extended: true });
  if (!compareSummary(footer, summary)) throw new Error("PREMiSE backup checksum or count mismatch");
  return { ...header, ...summary };
}

export async function readLegacyBackup(file) {
  return parseBackup(JSON.parse(await readFile(file, "utf8")));
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new TypeError("PostgreSQL table prefix must be a lowercase SQL identifier");
  return `"${value}"`;
}

function runtimeTables(store) {
  if (store === null || typeof store !== "object" || store.client === null || typeof store.client !== "object" || typeof store.client.query !== "function") return undefined;
  if (typeof store.tablePrefix !== "string" || !/^[a-z_][a-z0-9_]*$/u.test(store.tablePrefix)) throw new TypeError("PostgreSQL table prefix must be a lowercase SQL identifier");
  if (typeof store.tenantId !== "string" || store.tenantId.length === 0 || store.tenantId.trim() !== store.tenantId) throw new TypeError("PostgreSQL backup requires a tenant-scoped store");
  const prefix = store.tablePrefix;
  return {
    client: store.client,
    tenantId: store.tenantId,
    records: quoteIdentifier(`${prefix}_records`),
    events: quoteIdentifier(`${prefix}_events`),
    snapshots: quoteIdentifier(`${prefix}_snapshots`),
    checkpoints: quoteIdentifier(`${prefix}_replay_checkpoints`),
    idempotency: quoteIdentifier(`${prefix}_http_idempotency`),
    sequenceTable: `${prefix}_events`
  };
}

async function withPostgresTransaction(adapter, action, readOnly = false) {
  if (typeof adapter.transaction === "function") {
    return adapter.transaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      if (readOnly) await client.query("SET TRANSACTION READ ONLY");
      return action(client);
    });
  }
  await adapter.query(`BEGIN ISOLATION LEVEL REPEATABLE READ${readOnly ? " READ ONLY" : ""}`);
  try {
    const result = await action(adapter);
    await adapter.query("COMMIT");
    return result;
  } catch (error) {
    try { await adapter.query("ROLLBACK"); } catch { /* preserve the operation failure */ }
    throw error;
  }
}

async function setTenantContext(client, tenantId) {
  await client.query("SELECT set_config('premise.tenant_id', $1, true)", [tenantId]);
}

function rowValue(row, column, label, allowNull = false) {
  const value = row[column];
  if (value === undefined || (!allowNull && value === null)) throw new Error(`PostgreSQL backup row is missing ${label}`);
  return value;
}

function rowNumber(row, column, label, minimum = 0) {
  const value = rowValue(row, column, label);
  const result = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  assertSequence(result, label, minimum);
  return result;
}

function rowJson(row, column, label, allowNull = false) {
  return parseJson(rowValue(row, column, label, allowNull), label, allowNull);
}

function rowDate(row, column, label) {
  return normalizedDateTime(rowValue(row, column, label), label);
}

function rawRecord(row, tenantId) {
  const rowTenant = rowValue(row, "tenant_id", "record.tenant_id");
  const envelope = rowJson(row, "envelope_json", "record.envelope_json");
  const record = { envelope, content: rowJson(row, "content_json", "record.content_json") };
  if (rowTenant !== envelope?.tenantId || envelope?.memoryId !== rowValue(row, "memory_id", "record.memory_id")) throw new Error("PREMiSE backup record identity mismatch");
  validateEntry("record", record, tenantId);
  return record;
}

function rawEvent(row, tenantId) {
  const rowTenant = rowValue(row, "tenant_id", "event.tenant_id");
  const event = rowJson(row, "event_json", "event.event_json");
  if (rowTenant !== event?.tenantId) throw new Error("PREMiSE backup event tenant mismatch");
  validateEntry("event", event, tenantId);
  return { event, sequence: rowNumber(row, "sequence", "event.sequence", 1) };
}

function rawSnapshot(row, tenantId) {
  const value = {
    tenantId: rowValue(row, "tenant_id", "snapshot.tenant_id"),
    snapshotId: rowValue(row, "snapshot_id", "snapshot.snapshot_id"),
    capturedAt: rowDate(row, "captured_at", "snapshot.captured_at"),
    snapshot: rowJson(row, "snapshot_json", "snapshot.snapshot_json"),
    createdAt: rowDate(row, "created_at", "snapshot.created_at")
  };
  validateEntry("snapshot", value, tenantId);
  return value;
}

function rawCheckpoint(row, tenantId) {
  const value = {
    tenantId: rowValue(row, "tenant_id", "checkpoint.tenant_id"),
    consumerId: rowValue(row, "consumer_id", "checkpoint.consumer_id"),
    eventSequence: rowNumber(row, "event_sequence", "checkpoint.event_sequence"),
    updatedAt: rowDate(row, "updated_at", "checkpoint.updated_at")
  };
  validateEntry("checkpoint", value, tenantId);
  return value;
}

function rawHttpIdempotency(row, tenantId) {
  const value = {
    tenantId: rowValue(row, "tenant_id", "http idempotency.tenant_id"),
    operation: rowValue(row, "operation", "http idempotency.operation"),
    idempotencyKey: rowValue(row, "idempotency_key", "http idempotency.idempotency_key"),
    requestHash: rowValue(row, "request_hash", "http idempotency.request_hash"),
    state: rowValue(row, "state", "http idempotency.state"),
    leaseToken: rowValue(row, "lease_token", "http idempotency.lease_token"),
    statusCode: row.status_code === null ? null : rowNumber(row, "status_code", "http idempotency.status_code", 100),
    response: rowJson(row, "response_json", "http idempotency.response_json", true),
    responseHeaders: rowJson(row, "response_headers", "http idempotency.response_headers"),
    createdAt: rowDate(row, "created_at", "http idempotency.created_at"),
    updatedAt: rowDate(row, "updated_at", "http idempotency.updated_at")
  };
  validateEntry("http_idempotency", value, tenantId);
  return value;
}

async function walkPostgresState(store, sink, batchSize, options = {}) {
  const tables = runtimeTables(store);
  if (tables === undefined) return undefined;
  const size = batchSize ?? 1_000;
  if (!Number.isSafeInteger(size) || size < 1 || size > 10_000) throw new TypeError("PREMISE_BACKUP_BATCH_SIZE must be an integer from 1 to 10000");
  const includeAuxiliary = options.includeAuxiliary !== false;
  return withPostgresTransaction(tables.client, async (client) => {
    const counts = emptyCounts();
    await setTenantContext(client, tables.tenantId);

    let memoryCursor = "";
    while (true) {
      const result = await client.query(`
        SELECT tenant_id, memory_id, envelope_json::text AS envelope_json, content_json::text AS content_json
        FROM ${tables.records}
        WHERE tenant_id = $1 AND memory_id > $2
        ORDER BY memory_id
        LIMIT $3
      `, [tables.tenantId, memoryCursor, size]);
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        const record = rawRecord(row, tables.tenantId);
        await sink.onRecord(record);
        memoryCursor = record.envelope.memoryId;
        counts.records += 1;
      }
      if (result.rows.length < size) break;
    }

    let eventCursor = 0;
    while (true) {
      const result = await client.query(`
        SELECT sequence, tenant_id, event_json::text AS event_json
        FROM ${tables.events}
        WHERE tenant_id = $1 AND sequence > $2
        ORDER BY sequence
        LIMIT $3
      `, [tables.tenantId, eventCursor, size]);
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        const entry = rawEvent(row, tables.tenantId);
        await sink.onEvent(entry.event, entry.sequence);
        eventCursor = entry.sequence;
        counts.events += 1;
      }
      if (result.rows.length < size) break;
    }

    if (!includeAuxiliary) return counts;

    const snapshotTenants = ["__all__", tables.tenantId].filter((tenantId, index, values) => values.indexOf(tenantId) === index);
    for (const snapshotTenant of snapshotTenants) {
      await setTenantContext(client, snapshotTenant);
      const result = await client.query(`
        SELECT tenant_id, snapshot_id, captured_at, snapshot_json::text AS snapshot_json, created_at
        FROM ${tables.snapshots}
        WHERE tenant_id = $1
        ORDER BY snapshot_id
      `, [snapshotTenant]);
      for (const row of result.rows) {
        await sink.onSnapshot(rawSnapshot(row, tables.tenantId));
        counts.snapshots += 1;
      }
    }

    await setTenantContext(client, tables.tenantId);
    const checkpointResult = await client.query(`
      SELECT tenant_id, consumer_id, event_sequence, updated_at
      FROM ${tables.checkpoints}
      WHERE tenant_id = $1
      ORDER BY consumer_id
    `, [tables.tenantId]);
    for (const row of checkpointResult.rows) {
      await sink.onCheckpoint(rawCheckpoint(row, tables.tenantId));
      counts.checkpoints += 1;
    }

    const idempotencyResult = await client.query(`
      SELECT tenant_id, operation, idempotency_key, request_hash, state, lease_token, status_code,
             response_json::text AS response_json, response_headers::text AS response_headers,
             created_at, updated_at
      FROM ${tables.idempotency}
      WHERE tenant_id = $1
      ORDER BY operation, idempotency_key
    `, [tables.tenantId]);
    for (const row of idempotencyResult.rows) {
      await sink.onHttpIdempotency(rawHttpIdempotency(row, tables.tenantId));
      counts.httpIdempotency += 1;
    }
    return counts;
  }, true);
}

function sameCounts(left, right) {
  return COUNT_FIELDS.every((field) => (left[field] ?? 0) === (right[field] ?? 0));
}

export async function writeIncrementalBackupFile(store, output, metadata = {}) {
  if (store === null || typeof store !== "object") throw new TypeError("NDJSON backup requires a PostgreSQL store");
  const tables = runtimeTables(store);
  if (typeof store.loadIncrementally !== "function" && tables === undefined) throw new TypeError("NDJSON backup requires a PostgreSQL store with loadIncrementally");
  if (tables !== undefined && metadata.tenantId !== undefined && metadata.tenantId !== tables.tenantId) throw new Error("PREMiSE backup tenant does not match the PostgreSQL store");
  const batchSize = metadata.batchSize ?? parseBackupBatchSize();
  const target = path.resolve(output);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const stream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const writer = createIncrementalBackupWriter(stream, metadata);
  try {
    await writer.ready;
    const loaded = await walkPostgresState(store, {
      onRecord: (record) => writer.writeRecord(record),
      onEvent: (event, sequence) => writer.writeEvent(event, sequence),
      onSnapshot: (snapshot) => writer.writeSnapshot(snapshot),
      onCheckpoint: (checkpoint) => writer.writeCheckpoint(checkpoint),
      onHttpIdempotency: (value) => writer.writeHttpIdempotency(value)
    }, batchSize);
    const fallbackLoaded = loaded ?? await store.loadIncrementally({
      batchSize,
      onRecord: (record) => writer.writeRecord(record),
      onEvent: (event, sequence) => writer.writeEvent(event, sequence)
    });
    const written = await writer.finish();
    if (!sameCounts(fallbackLoaded, written)) throw new Error("PREMiSE incremental backup count verification failed");
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    return { ...written, file: target };
  } catch (error) {
    await writer.abort().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function clearRuntimeTables(client, tables) {
  await setTenantContext(client, tables.tenantId);
  await client.query(`DELETE FROM ${tables.idempotency} WHERE tenant_id = $1`, [tables.tenantId]);
  await client.query(`DELETE FROM ${tables.checkpoints} WHERE tenant_id = $1`, [tables.tenantId]);
  await client.query(`DELETE FROM ${tables.events} WHERE tenant_id = $1`, [tables.tenantId]);
  await client.query(`DELETE FROM ${tables.records} WHERE tenant_id = $1`, [tables.tenantId]);
  await setTenantContext(client, "__all__");
  await client.query(`DELETE FROM ${tables.snapshots} WHERE tenant_id = $1`, ["__all__"]);
  if (tables.tenantId !== "__all__") {
    await setTenantContext(client, tables.tenantId);
    await client.query(`DELETE FROM ${tables.snapshots} WHERE tenant_id = $1`, [tables.tenantId]);
  }
}

async function insertRecord(client, tables, record) {
  validateEntry("record", record, tables.tenantId);
  const result = await client.query(`
    INSERT INTO ${tables.records}(tenant_id, memory_id, envelope_json, content_json)
    VALUES ($1, $2, $3::jsonb, $4::jsonb)
    ON CONFLICT DO NOTHING
    RETURNING memory_id
  `, [tables.tenantId, record.envelope.memoryId, jsonText(record.envelope, "record.envelope"), jsonText(record.content, "record.content")]);
  if (result.rows.length !== 1) throw new Error(`PREMiSE restore contains a duplicate record: ${record.envelope.memoryId}`);
}

async function insertEvent(client, tables, event, sequence) {
  validateEntry("event", event, tables.tenantId);
  if (sequence !== undefined) assertSequence(sequence, "event.sequence", 1);
  const columns = sequence === undefined ? "tenant_id, idempotency_key, event_id, event_json, occurred_at" : "sequence, tenant_id, idempotency_key, event_id, event_json, occurred_at";
  const values = sequence === undefined ? "$1, $2, $3, $4::jsonb, $5" : "$1, $2, $3, $4, $5::jsonb, $6";
  const parameters = sequence === undefined
    ? [tables.tenantId, event.idempotencyKey, event.eventId, jsonText(event, "event"), event.occurredAt]
    : [sequence, tables.tenantId, event.idempotencyKey, event.eventId, jsonText(event, "event"), event.occurredAt];
  const result = await client.query(`
    INSERT INTO ${tables.events}(${columns})
    VALUES (${values})
    ON CONFLICT DO NOTHING
    RETURNING sequence
  `, parameters);
  if (result.rows.length !== 1) throw new Error(`PREMiSE restore contains a duplicate event: ${event.idempotencyKey}`);
}

async function insertSnapshot(client, tables, value) {
  validateEntry("snapshot", value, tables.tenantId);
  await setTenantContext(client, value.tenantId);
  const result = await client.query(`
    INSERT INTO ${tables.snapshots}(tenant_id, snapshot_id, captured_at, snapshot_json, created_at)
    VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, CURRENT_TIMESTAMP))
    ON CONFLICT DO NOTHING
    RETURNING snapshot_id
  `, [value.tenantId, value.snapshotId, value.capturedAt, jsonText(value.snapshot, "snapshot.snapshot"), value.createdAt ?? null]);
  if (result.rows.length !== 1) throw new Error(`PREMiSE restore contains a duplicate snapshot: ${value.snapshotId}`);
}

async function insertCheckpoint(client, tables, value) {
  validateEntry("checkpoint", value, tables.tenantId);
  await setTenantContext(client, tables.tenantId);
  const result = await client.query(`
    INSERT INTO ${tables.checkpoints}(tenant_id, consumer_id, event_sequence, updated_at)
    VALUES ($1, $2, $3, COALESCE($4::timestamptz, CURRENT_TIMESTAMP))
    ON CONFLICT DO NOTHING
    RETURNING consumer_id
  `, [tables.tenantId, value.consumerId, value.eventSequence, value.updatedAt ?? null]);
  if (result.rows.length !== 1) throw new Error(`PREMiSE restore contains a duplicate checkpoint: ${value.consumerId}`);
}

async function insertHttpIdempotency(client, tables, value) {
  validateEntry("http_idempotency", value, tables.tenantId);
  const responseJson = value.state === "IN_PROGRESS" ? null : jsonText(value.response, "http idempotency.response");
  await setTenantContext(client, tables.tenantId);
  const result = await client.query(`
    INSERT INTO ${tables.idempotency}(
      tenant_id, operation, idempotency_key, request_hash, state, lease_token,
      status_code, response_json, response_headers, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
            COALESCE($10::timestamptz, CURRENT_TIMESTAMP), COALESCE($11::timestamptz, CURRENT_TIMESTAMP))
    ON CONFLICT DO NOTHING
    RETURNING idempotency_key
  `, [tables.tenantId, value.operation, value.idempotencyKey, value.requestHash, value.state, value.leaseToken, value.statusCode ?? null, responseJson, jsonText(value.responseHeaders ?? {}, "http idempotency.responseHeaders"), value.createdAt ?? null, value.updatedAt ?? null]);
  if (result.rows.length !== 1) throw new Error(`PREMiSE restore contains a duplicate HTTP idempotency key: ${value.operation}/${value.idempotencyKey}`);
}

async function repairEventSequence(client, tables) {
  await setTenantContext(client, tables.tenantId);
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence($1, 'sequence'),
      GREATEST(COALESCE((SELECT MAX(sequence) FROM ${tables.events}), 1), 1),
      true
    )
  `, [tables.sequenceTable]);
}

async function restorePostgresState(store, produce) {
  const tables = runtimeTables(store);
  if (tables === undefined) throw new TypeError("PREMiSE restore requires a PostgreSQL runtime store");
  return withPostgresTransaction(tables.client, async (client) => {
    await clearRuntimeTables(client, tables);
    const counts = emptyCounts();
    let maxSequence = 0;
    const sink = {
      onRecord: async (record) => {
        await setTenantContext(client, tables.tenantId);
        await insertRecord(client, tables, record);
        counts.records += 1;
      },
      onEvent: async (event, sequence) => {
        await setTenantContext(client, tables.tenantId);
        await insertEvent(client, tables, event, sequence);
        if (sequence !== undefined) maxSequence = Math.max(maxSequence, sequence);
        counts.events += 1;
      },
      onSnapshot: async (snapshot) => {
        await insertSnapshot(client, tables, snapshot);
        counts.snapshots += 1;
      },
      onCheckpoint: async (checkpoint) => {
        await insertCheckpoint(client, tables, checkpoint);
        counts.checkpoints += 1;
      },
      onHttpIdempotency: async (value) => {
        await insertHttpIdempotency(client, tables, value);
        counts.httpIdempotency += 1;
      }
    };
    const source = await produce(sink);
    if (source === null || typeof source !== "object") throw new Error("PREMiSE restore source did not return a summary");
    if (typeof source.capturedAt !== "string") throw new Error("PREMiSE restore source capturedAt is invalid");
    if (!sameCounts(source, counts)) throw new Error("PREMiSE restore source count verification failed");
    if (maxSequence > 0) await repairEventSequence(client, tables);
    return source;
  });
}

export async function restoreIncrementalBackup(store, file, options = {}) {
  const tenantId = options.tenantId ?? store?.tenantId;
  if (typeof tenantId !== "string") throw new TypeError("PREMiSE restore requires a tenantId");
  return restorePostgresState(store, (sink) => readIncrementalBackup(file, {
    expectedTenantId: tenantId,
    onRecord: sink.onRecord,
    onEvent: sink.onEvent,
    onSnapshot: sink.onSnapshot,
    onCheckpoint: sink.onCheckpoint,
    onHttpIdempotency: sink.onHttpIdempotency
  }));
}

export async function restoreLegacyBackup(store, snapshot, options = {}) {
  const tenantId = options.tenantId ?? store?.tenantId;
  if (typeof tenantId !== "string") throw new TypeError("PREMiSE restore requires a tenantId");
  if (snapshot === null || typeof snapshot !== "object" || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.events)) throw new Error("PREMiSE legacy backup snapshot is invalid");
  return restorePostgresState(store, async (sink) => {
    const digest = createIncrementalDigest();
    for (const record of snapshot.records) {
      await sink.onRecord(record);
      digest.addRecord(record);
    }
    for (const event of snapshot.events) {
      await sink.onEvent(event);
      digest.addEvent(event);
    }
    const storedSnapshot = { tenantId: "__all__", snapshotId: snapshot.capturedAt, capturedAt: snapshot.capturedAt, snapshot };
    await sink.onSnapshot(storedSnapshot);
    digest.addSnapshot(storedSnapshot);
    return { capturedAt: snapshot.capturedAt, ...digest.finish({ extended: true }) };
  });
}

export async function digestStoreIncrementally(store, options = {}) {
  if (store === null || typeof store !== "object") throw new TypeError("PREMiSE store does not support incremental loading");
  const digest = createIncrementalDigest();
  const expectedTenantId = options.tenantId ?? store.tenantId;
  const includeAuxiliary = options.includeAuxiliary !== false;
  const includeEventSequence = options.includeEventSequence !== false;
  const loaded = await walkPostgresState(store, {
    onRecord: (record) => {
      if (expectedTenantId !== undefined) assertEntryTenant("record", record, expectedTenantId);
      digest.addRecord(record);
    },
    onEvent: (event, sequence) => {
      if (expectedTenantId !== undefined) assertEntryTenant("event", event, expectedTenantId);
      digest.addEvent(event, includeEventSequence ? sequence : undefined);
    },
    onSnapshot: (snapshot) => digest.addSnapshot(snapshot),
    onCheckpoint: (checkpoint) => digest.addCheckpoint(checkpoint),
    onHttpIdempotency: (value) => digest.addHttpIdempotency(value)
  }, options.batchSize, { includeAuxiliary });
  const fallbackLoaded = loaded ?? await store.loadIncrementally({
    batchSize: options.batchSize,
    onRecord: (record) => {
      if (expectedTenantId !== undefined) assertEntryTenant("record", record, expectedTenantId);
      digest.addRecord(record);
    },
    onEvent: (event, sequence) => {
      if (expectedTenantId !== undefined) assertEntryTenant("event", event, expectedTenantId);
      digest.addEvent(event, includeEventSequence ? sequence : undefined);
    }
  });
  const result = digest.finish({ extended: true });
  if (!sameCounts(fallbackLoaded, result)) throw new Error("PREMiSE store incremental digest count verification failed");
  return result;
}
