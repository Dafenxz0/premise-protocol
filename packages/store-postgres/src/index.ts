import { parseMemoryEnvelopeV2, parseV2Event, type V2Event } from "@premise/protocol-types";
import type { RuntimeRecord, RuntimeSnapshot } from "@premise/runtime-core";

export interface PostgresQueryResult<Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly rows: readonly Row[];
}

export interface PostgresClient {
  query<Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
  transaction?<T>(action: (client: PostgresClient) => Promise<T>): Promise<T>;
}

export interface AsyncRuntimeStore<T> {
  get(memoryId: string): Promise<RuntimeRecord<T> | undefined>;
  list(): Promise<readonly RuntimeRecord<T>[]>;
  put(record: RuntimeRecord<T>): Promise<void>;
  appendEvent(event: V2Event): Promise<void>;
  hasEvent(idempotencyKey: string): Promise<boolean>;
  listEvents(): Promise<readonly V2Event[]>;
  snapshot(capturedAt: string): Promise<RuntimeSnapshot<T>>;
  restore(snapshot: RuntimeSnapshot<T>): Promise<void>;
}

function json<T>(value: T): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("PostgreSQL runtime values must be JSON serializable");
  return serialized;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new TypeError("PostgreSQL table prefix must be a lowercase SQL identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

function rowText(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`PostgreSQL runtime row is missing ${key}`);
  return value;
}

export class PostgresRuntimeStore<T = unknown> implements AsyncRuntimeStore<T> {
  private readonly recordsTable: string;
  private readonly eventsTable: string;

  constructor(readonly client: PostgresClient, tablePrefix = "premise_v2") {
    this.recordsTable = identifier(`${tablePrefix}_records`);
    this.eventsTable = identifier(`${tablePrefix}_events`);
  }

  async migrate(): Promise<void> {
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${this.recordsTable} (
        memory_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        envelope_json JSONB NOT NULL,
        content_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
        sequence BIGSERIAL PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        event_json JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${identifier(`${this.eventsTable.replaceAll('"', "")}_memory_idx`)} ON ${this.eventsTable} ((event_json->>'memoryId'), sequence);
    `);
  }

  async get(memoryId: string): Promise<RuntimeRecord<T> | undefined> {
    const rows = await this.client.query<Readonly<Record<string, unknown>>>(`SELECT envelope_json, content_json FROM ${this.recordsTable} WHERE memory_id = $1`, [memoryId]);
    const row = rows.rows[0];
    if (row === undefined) return undefined;
    return { envelope: parseMemoryEnvelopeV2(typeof row.envelope_json === "string" ? JSON.parse(row.envelope_json) : row.envelope_json), content: (typeof row.content_json === "string" ? JSON.parse(row.content_json) : row.content_json) as T };
  }

  async list(): Promise<readonly RuntimeRecord<T>[]> {
    const rows = await this.client.query<Readonly<Record<string, unknown>>>(`SELECT envelope_json, content_json FROM ${this.recordsTable} ORDER BY memory_id`);
    return rows.rows.map((row) => ({ envelope: parseMemoryEnvelopeV2(typeof row.envelope_json === "string" ? JSON.parse(row.envelope_json) : row.envelope_json), content: (typeof row.content_json === "string" ? JSON.parse(row.content_json) : row.content_json) as T }));
  }

  async put(record: RuntimeRecord<T>): Promise<void> {
    const envelope = parseMemoryEnvelopeV2(record.envelope);
    await this.client.query(`
      INSERT INTO ${this.recordsTable}(memory_id, tenant_id, envelope_json, content_json)
      VALUES ($1, $2, $3::jsonb, $4::jsonb)
      ON CONFLICT(memory_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, envelope_json = EXCLUDED.envelope_json, content_json = EXCLUDED.content_json, updated_at = NOW()
    `, [envelope.memoryId, envelope.tenantId, json(envelope), json(record.content)]);
  }

  async appendEvent(event: V2Event): Promise<void> {
    const parsed = parseV2Event(event);
    const serialized = json(parsed);
    const result = await this.client.query(`
      INSERT INTO ${this.eventsTable}(idempotency_key, event_id, tenant_id, event_json, occurred_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT(idempotency_key) DO NOTHING
      RETURNING event_id, event_json
    `, [parsed.idempotencyKey, parsed.eventId, parsed.tenantId, serialized, parsed.occurredAt]);
    if (result.rows.length > 0) return;
    const existing = await this.client.query<Readonly<Record<string, unknown>>>(`SELECT event_id, event_json FROM ${this.eventsTable} WHERE idempotency_key = $1`, [parsed.idempotencyKey]);
    const row = existing.rows[0];
    if (row === undefined) throw new Error(`Idempotency event was not stored: ${parsed.idempotencyKey}`);
    const existingEventId = row.event_id;
    const existingEvent = typeof row.event_json === "string" ? JSON.parse(row.event_json) : row.event_json;
    if (existingEventId !== parsed.eventId || JSON.stringify(existingEvent) !== serialized) throw new Error(`Conflicting idempotency key: ${parsed.idempotencyKey}`);
  }

  async hasEvent(idempotencyKey: string): Promise<boolean> {
    const result = await this.client.query(`SELECT 1 AS present FROM ${this.eventsTable} WHERE idempotency_key = $1`, [idempotencyKey]);
    return result.rows.length > 0;
  }

  async listEvents(): Promise<readonly V2Event[]> {
    const result = await this.client.query<Readonly<Record<string, unknown>>>(`SELECT event_json FROM ${this.eventsTable} ORDER BY sequence`);
    return result.rows.map((row) => parseV2Event(typeof row.event_json === "string" ? JSON.parse(row.event_json) : row.event_json));
  }

  async snapshot(capturedAt: string): Promise<RuntimeSnapshot<T>> {
    return { format: "premise-runtime-snapshot", version: 1, capturedAt, records: await this.list(), events: await this.listEvents() };
  }

  async restore(snapshot: RuntimeSnapshot<T>): Promise<void> {
    const action = async (client: PostgresClient): Promise<void> => {
      await client.query(`DELETE FROM ${this.recordsTable}; DELETE FROM ${this.eventsTable};`);
      const transactional = new PostgresRuntimeStore<T>(client, this.recordsTable.replaceAll('"', "").replace(/_records$/u, ""));
      for (const record of snapshot.records) await transactional.put(record);
      for (const event of snapshot.events) await transactional.appendEvent(event);
    };
    if (this.client.transaction) await this.client.transaction(action); else await action(this.client);
  }
}

export * from "./persistent.js";
