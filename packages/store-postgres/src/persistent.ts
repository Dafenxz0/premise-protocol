import { parseMemoryEnvelope, type MemoryEnvelope, type PremiseEvent } from "@premise/protocol-types";
import { parsePremiseEvent } from "@premise/reference-ts";
import { withPostgresTransaction, type PostgresAdapter, type PostgresQuery, type PostgresQueryResult } from "./driver.js";
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

export const POSTGRES_STORE_SCHEMA_VERSION = 1 as const;

export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS premise_store_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS premise_store_envelopes (
  memory_id TEXT PRIMARY KEY,
  envelope_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS premise_store_events (
  sequence BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  memory_id TEXT,
  occurred_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS premise_store_events_memory_idx
  ON premise_store_events(memory_id, sequence);

CREATE TABLE IF NOT EXISTS premise_store_snapshots (
  memory_id TEXT PRIMARY KEY,
  event_sequence BIGINT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS premise_store_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO premise_store_schema_migrations(version)
VALUES (${POSTGRES_STORE_SCHEMA_VERSION})
ON CONFLICT (version) DO NOTHING;
`;

export type { PostgresAdapter, PostgresQuery, PostgresQueryResult } from "./driver.js";
export type PostgresDriver = PostgresAdapter;

export interface PostgresStoreOptions {
  readonly autoMigrate?: boolean;
}

function assertAdapter(adapter: PostgresAdapter): void {
  if (adapter === null || typeof adapter !== "object" || typeof adapter.query !== "function") {
    throw new TypeError("PostgresAdapter must provide query(sql, parameters)");
  }
}

function rowText(row: Readonly<Record<string, unknown>>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`PostgreSQL row is missing text column ${column}`);
  return value;
}

function rowSequence(row: Readonly<Record<string, unknown>>, column: string): number {
  const value = row[column];
  const sequence = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`PostgreSQL row has invalid integer column ${column}`);
  return sequence;
}

function rowJson(row: Readonly<Record<string, unknown>>, column: string): unknown {
  try {
    return JSON.parse(rowText(row, column)) as unknown;
  } catch (error) {
    throw new Error(`PostgreSQL row has invalid JSON column ${column}`, { cause: error });
  }
}

function storedEnvelope(row: Readonly<Record<string, unknown>>): MemoryEnvelope {
  return parseMemoryEnvelope(rowJson(row, "envelope_json"));
}

function storedEvent(row: Readonly<Record<string, unknown>>): PremiseEvent {
  return parsePremiseEvent(rowJson(row, "event_json"));
}

function storedSnapshot<T>(row: Readonly<Record<string, unknown>>): NormalizedSnapshot<T> {
  return normalizeSnapshot({
    memoryId: rowText(row, "memory_id"),
    sequence: rowSequence(row, "event_sequence"),
    state: rowJson(row, "state_json"),
    updatedAt: rowText(row, "updated_at")
  }) as NormalizedSnapshot<T>;
}

function storedIdempotency<T>(row: Readonly<Record<string, unknown>>): NormalizedIdempotencyRecord<T> {
  const requestHash = row.request_hash;
  if (requestHash !== null && requestHash !== undefined && typeof requestHash !== "string") throw new Error("PostgreSQL row has invalid request_hash");
  return normalizeIdempotency({
    key: rowText(row, "idempotency_key"),
    ...(requestHash === null || requestHash === undefined ? {} : { requestHash }),
    response: rowJson(row, "response_json"),
    createdAt: rowText(row, "created_at")
  }) as NormalizedIdempotencyRecord<T>;
}

export class PostgresPersistentStore implements PersistentStore {
  private readonly adapter: PostgresAdapter;
  private readonly ready: Promise<void>;
  private closed = false;

  constructor(adapter: PostgresAdapter, options: PostgresStoreOptions = {}) {
    assertAdapter(adapter);
    this.adapter = adapter;
    this.ready = options.autoMigrate === false ? Promise.resolve() : this.runMigrations();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async initialize(): Promise<void> {
    await this.ready;
  }

  async migrate(): Promise<void> {
    this.ensureOpen();
    await this.ready;
    await this.runMigrations();
  }

  async saveEnvelope(input: MemoryEnvelope): Promise<void> {
    const envelope = parseMemoryEnvelope(cloneJson(input));
    await this.prepare();
    await this.adapter.query(`
      INSERT INTO premise_store_envelopes(memory_id, envelope_json, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (memory_id) DO UPDATE SET
        envelope_json = EXCLUDED.envelope_json,
        updated_at = EXCLUDED.updated_at
    `, [envelope.memoryId, JSON.stringify(envelope), envelope.validity.checkedAt]);
  }

  async upsertEnvelope(input: MemoryEnvelope): Promise<void> {
    await this.saveEnvelope(input);
  }

  async getEnvelope(memoryId: string): Promise<MemoryEnvelope | undefined> {
    assertLookupKey(memoryId, "memoryId");
    await this.prepare();
    const result = await this.adapter.query(`
      SELECT envelope_json
      FROM premise_store_envelopes
      WHERE memory_id = $1
    `, [memoryId]);
    const row = result.rows[0];
    return row === undefined ? undefined : cloneJson(storedEnvelope(row));
  }

  async listEnvelopes(): Promise<readonly MemoryEnvelope[]> {
    await this.prepare();
    const result = await this.adapter.query(`
      SELECT envelope_json
      FROM premise_store_envelopes
      ORDER BY memory_id ASC
    `);
    return result.rows.map((row) => cloneJson(storedEnvelope(row)));
  }

  async appendEvent(input: PremiseEvent): Promise<PremiseEvent> {
    const event = parsePremiseEvent(cloneJson(input));
    await this.prepare();
    const result = await this.adapter.query(`
      INSERT INTO premise_store_events(event_id, memory_id, occurred_at, event_type, event_json)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (event_id) DO NOTHING
    `, [event.eventId, event.memoryId ?? null, event.occurredAt, event.type, JSON.stringify(event)]);
    if (result.rowCount === 0) throw new Error(`Duplicate eventId: ${event.eventId}`);
    return cloneJson(event);
  }

  async listEvents(memoryId?: string): Promise<readonly PremiseEvent[]> {
    if (memoryId !== undefined) assertLookupKey(memoryId, "memoryId");
    await this.prepare();
    const result = memoryId === undefined
      ? await this.adapter.query(`SELECT event_json FROM premise_store_events ORDER BY sequence ASC`)
      : await this.adapter.query(`SELECT event_json FROM premise_store_events WHERE memory_id = $1 ORDER BY sequence ASC`, [memoryId]);
    return result.rows.map((row) => cloneJson(storedEvent(row)));
  }

  async history(memoryId: string): Promise<readonly PremiseEvent[]> {
    return this.listEvents(memoryId);
  }

  async saveSnapshot<T = unknown>(input: StoreSnapshot<T>): Promise<StoreSnapshot<T>> {
    const snapshot = normalizeSnapshot(input);
    await this.prepare();
    return withPostgresTransaction(this.adapter, async (client) => {
      await client.query(`
        INSERT INTO premise_store_snapshots(memory_id, event_sequence, state_json, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (memory_id) DO UPDATE SET
          event_sequence = EXCLUDED.event_sequence,
          state_json = EXCLUDED.state_json,
          updated_at = EXCLUDED.updated_at
        WHERE EXCLUDED.event_sequence >= premise_store_snapshots.event_sequence
      `, [snapshot.memoryId, snapshot.sequence, JSON.stringify(snapshot.state), snapshot.updatedAt]);
      const stored = await this.getSnapshotOn<T>(client, snapshot.memoryId);
      if (stored === undefined) throw new Error(`Snapshot was not stored: ${snapshot.memoryId}`);
      return cloneJson(stored);
    });
  }

  async putSnapshot<T = unknown>(input: StoreSnapshot<T>): Promise<StoreSnapshot<T>> {
    return this.saveSnapshot(input);
  }

  async getSnapshot<T = unknown>(memoryId: string): Promise<StoreSnapshot<T> | undefined> {
    assertLookupKey(memoryId, "memoryId");
    await this.prepare();
    const result = await this.adapter.query(`
      SELECT memory_id, event_sequence, state_json, updated_at
      FROM premise_store_snapshots
      WHERE memory_id = $1
    `, [memoryId]);
    const row = result.rows[0];
    return row === undefined ? undefined : cloneJson(storedSnapshot<T>(row));
  }

  async saveIdempotency<T = unknown>(input: IdempotencyRecord<T>): Promise<IdempotencyRecord<T>> {
    const record = normalizeIdempotency(input);
    await this.prepare();
    return withPostgresTransaction(this.adapter, async (client) => {
      await client.query(`
        INSERT INTO premise_store_idempotency(idempotency_key, request_hash, response_json, created_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [record.key, record.requestHash ?? null, JSON.stringify(record.response), record.createdAt]);
      const stored = await this.getIdempotencyOn<T>(client, record.key);
      if (stored === undefined) throw new Error(`Idempotency record was not stored: ${record.key}`);
      assertSameRequest(record, stored);
      return cloneJson(stored);
    });
  }

  async putIdempotency<T = unknown>(input: IdempotencyRecord<T>): Promise<IdempotencyRecord<T>> {
    return this.saveIdempotency(input);
  }

  async getIdempotency<T = unknown>(key: string): Promise<IdempotencyRecord<T> | undefined> {
    assertLookupKey(key, "idempotency key");
    await this.prepare();
    const result = await this.adapter.query(`
      SELECT idempotency_key, request_hash, response_json, created_at
      FROM premise_store_idempotency
      WHERE idempotency_key = $1
    `, [key]);
    const row = result.rows[0];
    return row === undefined ? undefined : cloneJson(storedIdempotency<T>(row));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.ready;
    } finally {
      this.closed = true;
      await this.adapter.close?.();
    }
  }

  private async prepare(): Promise<void> {
    this.ensureOpen();
    await this.ready;
  }

  private async runMigrations(): Promise<void> {
    await withPostgresTransaction(this.adapter, async (client) => {
      await client.query(POSTGRES_SCHEMA_SQL);
    });
  }

  private async getSnapshotOn<T = unknown>(client: PostgresAdapter, memoryId: string): Promise<StoreSnapshot<T> | undefined> {
    const result = await client.query(`
      SELECT memory_id, event_sequence, state_json, updated_at
      FROM premise_store_snapshots
      WHERE memory_id = $1
    `, [memoryId]);
    const row = result.rows[0];
    return row === undefined ? undefined : cloneJson(storedSnapshot<T>(row));
  }

  private async getIdempotencyOn<T = unknown>(client: PostgresAdapter, key: string): Promise<IdempotencyRecord<T> | undefined> {
    const result = await client.query(`
      SELECT idempotency_key, request_hash, response_json, created_at
      FROM premise_store_idempotency
      WHERE idempotency_key = $1
    `, [key]);
    const row = result.rows[0];
    return row === undefined ? undefined : cloneJson(storedIdempotency<T>(row));
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("PostgresPersistentStore is closed");
  }
}

function assertSameRequest<T>(requested: NormalizedIdempotencyRecord<T>, stored: IdempotencyRecord<T>): void {
  if (requested.requestHash !== undefined && stored.requestHash !== undefined && requested.requestHash !== stored.requestHash) {
    throw new Error(`Idempotency key already belongs to another request: ${requested.key}`);
  }
}

export { PostgresPersistentStore as PostgresStore };

export async function openPostgresStore(adapter: PostgresAdapter, options: PostgresStoreOptions = {}): Promise<PostgresPersistentStore> {
  const store = new PostgresPersistentStore(adapter, options);
  await store.initialize();
  return store;
}
