import { DatabaseSync } from "node:sqlite";
import { SqlitePremiseIndex } from "@premise/index-sqlite";
import { parseMemoryEnvelope, type MemoryEnvelope, type PremiseEvent } from "@premise/protocol-types";
import { parsePremiseEvent } from "@premise/reference-ts";
import {
  assertLookupKey,
  cloneJson,
  normalizeIdempotency,
  normalizeSnapshot,
  type IdempotencyRecord,
  type NormalizedIdempotencyRecord,
  type NormalizedSnapshot,
  type PersistentStore,
  type StoreSnapshot
} from "./types.js";

export type {
  IdempotencyEntry,
  IdempotencyRecord,
  PersistentStore,
  Snapshot,
  StoreResult,
  StoreSnapshot
} from "./types.js";

export const SQLITE_STORE_SCHEMA_VERSION = 1 as const;

export const SQLITE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS premise_store_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS premise_store_snapshots (
  memory_id TEXT PRIMARY KEY,
  event_sequence INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS premise_store_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function rowText(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`SQLite row is missing text column ${column}`);
  return value;
}

function rowSequence(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  const sequence = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`SQLite row has invalid integer column ${column}`);
  return sequence;
}

function rowJson(row: Record<string, unknown>, column: string): unknown {
  try {
    return JSON.parse(rowText(row, column)) as unknown;
  } catch (error) {
    throw new Error(`SQLite row has invalid JSON column ${column}`, { cause: error });
  }
}

function storedSnapshot<T>(row: Record<string, unknown>): NormalizedSnapshot<T> {
  return normalizeSnapshot({
    memoryId: rowText(row, "memory_id"),
    sequence: rowSequence(row, "event_sequence"),
    state: rowJson(row, "state_json"),
    updatedAt: rowText(row, "updated_at")
  }) as NormalizedSnapshot<T>;
}

function storedIdempotency<T>(row: Record<string, unknown>): NormalizedIdempotencyRecord<T> {
  const requestHash = row.request_hash;
  if (requestHash !== null && requestHash !== undefined && typeof requestHash !== "string") throw new Error("SQLite row has invalid request_hash");
  return normalizeIdempotency({
    key: rowText(row, "idempotency_key"),
    ...(requestHash === null || requestHash === undefined ? {} : { requestHash }),
    response: rowJson(row, "response_json"),
    createdAt: rowText(row, "created_at")
  }) as NormalizedIdempotencyRecord<T>;
}

function assertSameRequest<T>(requested: NormalizedIdempotencyRecord<T>, stored: IdempotencyRecord<T>): void {
  if (requested.requestHash !== undefined && stored.requestHash !== undefined && requested.requestHash !== stored.requestHash) {
    throw new Error(`Idempotency key already belongs to another request: ${requested.key}`);
  }
}

function migrate(database: DatabaseSync): void {
  database.exec(SQLITE_SCHEMA_SQL);
  const versions = database.prepare("SELECT version FROM premise_store_schema_migrations ORDER BY version ASC").all().map((row) => rowSequence(row, "version"));
  if (versions.some((version) => version > SQLITE_STORE_SCHEMA_VERSION)) throw new Error("SQLite store schema is newer than this implementation");
  if (!versions.includes(SQLITE_STORE_SCHEMA_VERSION)) database.prepare("INSERT INTO premise_store_schema_migrations(version) VALUES (?)").run(SQLITE_STORE_SCHEMA_VERSION);
}

export class SqlitePersistentStore implements PersistentStore {
  readonly filename: string;
  private index: SqlitePremiseIndex | undefined;
  private database: DatabaseSync | undefined;

  constructor(filename: string) {
    if (typeof filename !== "string" || filename.length === 0) throw new TypeError("SQLite filename must be non-empty");
    this.filename = filename;
    this.open();
  }

  get isOpen(): boolean {
    return this.index !== undefined && this.database !== undefined;
  }

  reopen(): void {
    this.close();
    this.open();
  }

  saveEnvelope(input: MemoryEnvelope): void {
    const envelope = parseMemoryEnvelope(cloneJson(input));
    this.requireIndex().upsertEnvelope(envelope);
  }

  upsertEnvelope(input: MemoryEnvelope): void {
    this.saveEnvelope(input);
  }

  getEnvelope(memoryId: string): MemoryEnvelope | undefined {
    assertLookupKey(memoryId, "memoryId");
    const envelope = this.requireIndex().getEnvelope(memoryId);
    return envelope === undefined ? undefined : cloneJson(envelope);
  }

  listEnvelopes(): readonly MemoryEnvelope[] {
    const rows = this.requireDatabase().prepare("SELECT envelope_json FROM premise_memories ORDER BY memory_id ASC").all();
    return rows.map((row) => parseMemoryEnvelope(rowJson(row, "envelope_json"))).map((envelope) => cloneJson(envelope));
  }

  appendEvent(input: PremiseEvent): PremiseEvent {
    const event = parsePremiseEvent(cloneJson(input));
    return cloneJson(this.requireIndex().appendEvent(event));
  }

  listEvents(memoryId?: string): readonly PremiseEvent[] {
    if (memoryId !== undefined) assertLookupKey(memoryId, "memoryId");
    return this.requireIndex().listEvents(memoryId).map((event) => cloneJson(event));
  }

  history(memoryId: string): readonly PremiseEvent[] {
    return this.listEvents(memoryId);
  }

  saveSnapshot<T = unknown>(input: StoreSnapshot<T>): StoreSnapshot<T> {
    const snapshot = normalizeSnapshot(input);
    this.transaction(() => {
      this.requireDatabase().prepare(`
        INSERT INTO premise_store_snapshots(memory_id, event_sequence, state_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          event_sequence = excluded.event_sequence,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
        WHERE excluded.event_sequence >= premise_store_snapshots.event_sequence
      `).run(snapshot.memoryId, snapshot.sequence, JSON.stringify(snapshot.state), snapshot.updatedAt);
    });
    const stored = this.getSnapshot<T>(snapshot.memoryId);
    if (stored === undefined) throw new Error(`Snapshot was not stored: ${snapshot.memoryId}`);
    return cloneJson(stored);
  }

  putSnapshot<T = unknown>(input: StoreSnapshot<T>): StoreSnapshot<T> {
    return this.saveSnapshot(input);
  }

  getSnapshot<T = unknown>(memoryId: string): StoreSnapshot<T> | undefined {
    assertLookupKey(memoryId, "memoryId");
    const row = this.requireDatabase().prepare(`
      SELECT memory_id, event_sequence, state_json, updated_at
      FROM premise_store_snapshots
      WHERE memory_id = ?
    `).get(memoryId);
    return row === undefined ? undefined : cloneJson(storedSnapshot<T>(row));
  }

  saveIdempotency<T = unknown>(input: IdempotencyRecord<T>): IdempotencyRecord<T> {
    const record = normalizeIdempotency(input);
    this.transaction(() => {
      this.requireDatabase().prepare(`
        INSERT INTO premise_store_idempotency(idempotency_key, request_hash, response_json, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `).run(record.key, record.requestHash ?? null, JSON.stringify(record.response), record.createdAt);
    });
    const stored = this.getIdempotency<T>(record.key);
    if (stored === undefined) throw new Error(`Idempotency record was not stored: ${record.key}`);
    assertSameRequest(record, stored);
    return cloneJson(stored);
  }

  putIdempotency<T = unknown>(input: IdempotencyRecord<T>): IdempotencyRecord<T> {
    return this.saveIdempotency(input);
  }

  getIdempotency<T = unknown>(key: string): IdempotencyRecord<T> | undefined {
    assertLookupKey(key, "idempotency key");
    const row = this.requireDatabase().prepare(`
      SELECT idempotency_key, request_hash, response_json, created_at
      FROM premise_store_idempotency
      WHERE idempotency_key = ?
    `).get(key);
    return row === undefined ? undefined : cloneJson(storedIdempotency<T>(row));
  }

  close(): void {
    const database = this.database;
    const index = this.index;
    this.database = undefined;
    this.index = undefined;
    database?.close();
    index?.close();
  }

  private open(): void {
    const index = new SqlitePremiseIndex(this.filename);
    try {
      const database = new DatabaseSync(this.filename);
      try {
        migrate(database);
        this.index = index;
        this.database = database;
      } catch (error) {
        database.close();
        throw error;
      }
    } catch (error) {
      index.close();
      throw error;
    }
  }

  private requireIndex(): SqlitePremiseIndex {
    if (this.index === undefined) throw new Error("SqlitePersistentStore is closed");
    return this.index;
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === undefined) throw new Error("SqlitePersistentStore is closed");
    return this.database;
  }

  private transaction(action: () => void): void {
    const database = this.requireDatabase();
    database.exec("BEGIN");
    try {
      action();
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Keep the original write error if the connection is already unusable.
      }
      throw error;
    }
  }
}

export { SqlitePersistentStore as SqliteStore };

export function openSqliteStore(filename: string): SqlitePersistentStore {
  return new SqlitePersistentStore(filename);
}
