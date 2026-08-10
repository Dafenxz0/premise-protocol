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

function assertCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`PREMiSE backup ${label} is invalid`);
}

function streamHeader(metadata) {
  if (metadata === null || typeof metadata !== "object") throw new TypeError("NDJSON backup metadata is required");
  const capturedAt = metadata.capturedAt ?? new Date().toISOString();
  const tenantId = metadata.tenantId;
  assertDateTime(capturedAt, "backup capturedAt");
  if (typeof tenantId !== "string" || tenantId.length === 0 || tenantId.trim() !== tenantId) throw new TypeError("backup tenantId must be a non-empty string without surrounding whitespace");
  return { format: STREAM_FORMAT, version: STREAM_VERSION, capturedAt, tenantId };
}

function dataLine(kind, value) {
  if (kind !== "record" && kind !== "event") throw new TypeError(`Unsupported NDJSON backup entry kind: ${kind}`);
  return `${canonicalJson({ kind, value })}\n`;
}

export function createIncrementalDigest() {
  const hash = createHash("sha256");
  let records = 0;
  let events = 0;
  let complete = false;

  function add(kind, value) {
    if (complete) throw new Error("PREMiSE backup digest is already finalized");
    hash.update(dataLine(kind, value), "utf8");
    if (kind === "record") records += 1;
    else events += 1;
  }

  return {
    addRecord(value) { add("record", value); },
    addEvent(value) { add("event", value); },
    finish() {
      if (complete) throw new Error("PREMiSE backup digest is already finalized");
      complete = true;
      return { records, events, sha256: hash.digest("hex") };
    }
  };
}

function assertEntryTenant(kind, value, tenantId) {
  const entryTenant = kind === "record" ? value?.envelope?.tenantId : value?.tenantId;
  if (entryTenant !== tenantId) throw new Error(`PREMiSE backup ${kind} tenant does not match the backup header`);
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

  const ready = enqueue(() => writeLine(stream, canonicalJson(header)));
  return {
    ready,
    writeRecord(value) {
      return enqueue(async () => {
        assertEntryTenant("record", value, header.tenantId);
        digest.addRecord(value);
        await writeLine(stream, dataLine("record", value).trimEnd());
      });
    },
    writeEvent(value) {
      return enqueue(async () => {
        assertEntryTenant("event", value, header.tenantId);
        digest.addEvent(value);
        await writeLine(stream, dataLine("event", value).trimEnd());
      });
    },
    finish() {
      return enqueue(async () => {
        const summary = digest.finish();
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

export async function writeIncrementalBackupFile(store, output, metadata = {}) {
  if (store === null || typeof store !== "object" || typeof store.loadIncrementally !== "function") throw new TypeError("NDJSON backup requires a PostgreSQL store with loadIncrementally");
  const batchSize = metadata.batchSize ?? parseBackupBatchSize();
  const target = path.resolve(output);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const stream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const writer = createIncrementalBackupWriter(stream, metadata);
  try {
    await writer.ready;
    const loaded = await store.loadIncrementally({
      batchSize,
      onRecord: (record) => writer.writeRecord(record),
      onEvent: (event) => writer.writeEvent(event)
    });
    const written = await writer.finish();
    if (loaded.records !== written.records || loaded.events !== written.events) throw new Error("PREMiSE incremental backup count verification failed");
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
  const onRecord = options.onRecord ?? (() => undefined);
  const onEvent = options.onEvent ?? (() => undefined);
  if (typeof onRecord !== "function" || typeof onEvent !== "function") throw new TypeError("NDJSON backup readers require onRecord and onEvent callbacks");
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const digest = createIncrementalDigest();
  let lineNumber = 0;
  let header;
  let footer;
  let phase = "records";
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
        assertCount(value.records, "footer.records");
        assertCount(value.events, "footer.events");
        if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) throw new Error("PREMiSE backup footer sha256 is invalid");
        footer = value;
        continue;
      }
      if (value?.kind === "record") {
        if (phase !== "records") throw new Error(`PREMiSE NDJSON backup record appears after events at line ${lineNumber}`);
        assertEntryTenant("record", value.value, header.tenantId);
        await onRecord(value.value);
        digest.addRecord(value.value);
        continue;
      }
      if (value?.kind === "event") {
        phase = "events";
        assertEntryTenant("event", value.value, header.tenantId);
        await onEvent(value.value);
        digest.addEvent(value.value);
        continue;
      }
      throw new Error(`PREMiSE NDJSON backup has an unsupported entry at line ${lineNumber}`);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (header === undefined) throw new Error("PREMiSE NDJSON backup header is missing");
  if (footer === undefined) throw new Error("PREMiSE NDJSON backup footer is missing");
  const summary = digest.finish();
  if (footer.records !== summary.records || footer.events !== summary.events || footer.sha256 !== summary.sha256) throw new Error("PREMiSE backup checksum or count mismatch");
  return { ...header, ...summary };
}

export async function readLegacyBackup(file) {
  return parseBackup(JSON.parse(await readFile(file, "utf8")));
}

export async function digestStoreIncrementally(store, options = {}) {
  if (store === null || typeof store !== "object" || typeof store.loadIncrementally !== "function") throw new TypeError("PREMiSE store does not support incremental loading");
  const digest = createIncrementalDigest();
  const expectedTenantId = options.tenantId;
  const loaded = await store.loadIncrementally({
    batchSize: options.batchSize,
    onRecord: (record) => {
      if (expectedTenantId !== undefined) assertEntryTenant("record", record, expectedTenantId);
      digest.addRecord(record);
    },
    onEvent: (event) => {
      if (expectedTenantId !== undefined) assertEntryTenant("event", event, expectedTenantId);
      digest.addEvent(event);
    }
  });
  const result = digest.finish();
  if (loaded.records !== result.records || loaded.events !== result.events) throw new Error("PREMiSE store incremental digest count verification failed");
  return result;
}
