import { randomUUID } from "node:crypto";
import { parseMemoryEnvelopeV2, parseV2Event, SPEC_VERSION_V2, type V2Event } from "@premise/protocol-types";
import type { RuntimeRecord, RuntimeSnapshot } from "@premise/runtime-core";
import {
  assertTenantId,
  identifier,
  json,
  jsonValue,
  rowSequence,
  rowText,
  setTenantContext,
  withPostgresTransaction,
  type PostgresAdapter,
  type PostgresQueryResult
} from "./driver.js";

export type { PostgresAdapter, PostgresClient, PostgresQuery, PostgresQueryResult } from "./driver.js";

export interface AsyncRuntimeStore<T> {
  get(memoryId: string): Promise<RuntimeRecord<T> | undefined>;
  list(): Promise<readonly RuntimeRecord<T>[]>;
  put(record: RuntimeRecord<T>): Promise<void>;
  putAndAppend?(record: RuntimeRecord<T>, event: V2Event): Promise<void>;
  appendEvent(event: V2Event): Promise<void>;
  hasEvent(idempotencyKey: string): Promise<boolean>;
  listEvents(): Promise<readonly V2Event[]>;
  snapshot(capturedAt: string): Promise<RuntimeSnapshot<T>>;
  restore(snapshot: RuntimeSnapshot<T>): Promise<void>;
}

export interface PostgresRuntimeMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface PostgresRuntimeStoreOptions {
  readonly tablePrefix?: string;
  readonly tenantId?: string;
  readonly autoMigrate?: boolean;
}

export interface HttpIdempotencyRequest {
  readonly tenantId: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: string;
}

export interface HttpIdempotencyResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type HttpIdempotencyClaim =
  | { readonly kind: "new"; readonly token: string }
  | { readonly kind: "replay"; readonly response: HttpIdempotencyResponse }
  | { readonly kind: "conflict" }
  | { readonly kind: "in-progress" };

export interface HttpIdempotencyCompletion extends HttpIdempotencyRequest {
  readonly token: string;
  readonly response: HttpIdempotencyResponse;
}

export interface HttpIdempotencyRelease extends HttpIdempotencyRequest {
  readonly token: string;
}

export interface PostgresReplayOptions {
  readonly consumerId?: string;
  readonly tenantId?: string;
  readonly batchSize?: number;
  readonly fromSequence?: number;
}

export type PostgresReplayHandler = (event: V2Event, sequence: number) => Promise<void> | void;

interface RuntimeTables {
  readonly prefix: string;
  readonly schema: string;
  readonly records: string;
  readonly events: string;
  readonly snapshots: string;
  readonly checkpoints: string;
  readonly idempotency: string;
}

function tables(prefix: string): RuntimeTables {
  if (!/^[a-z_][a-z0-9_]*$/u.test(prefix)) throw new TypeError("PostgreSQL table prefix must be a lowercase SQL identifier");
  return {
    prefix,
    schema: identifier(`${prefix}_schema_migrations`),
    records: identifier(`${prefix}_records`),
    events: identifier(`${prefix}_events`),
    snapshots: identifier(`${prefix}_snapshots`),
    checkpoints: identifier(`${prefix}_replay_checkpoints`),
    idempotency: identifier(`${prefix}_http_idempotency`)
  };
}

function migrationSql(runtime: RuntimeTables): readonly PostgresRuntimeMigration[] {
  const policy = (table: string): string => `${runtime.prefix}_${table}_tenant_policy`;
  const policySql = (table: string): string => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${identifier(policy(table.replaceAll('"', "").replace(`${runtime.prefix}_`, "")))} ON ${table};
CREATE POLICY ${identifier(policy(table.replaceAll('"', "").replace(`${runtime.prefix}_`, "")))} ON ${table}
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));
`;
  return [
    {
      version: 1,
      name: "runtime-core",
      sql: `
CREATE TABLE IF NOT EXISTS ${runtime.records} (
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  memory_id TEXT NOT NULL CHECK (length(trim(memory_id)) > 0),
  envelope_json JSONB NOT NULL CHECK (jsonb_typeof(envelope_json) = 'object'),
  content_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, memory_id)
);

CREATE TABLE IF NOT EXISTS ${runtime.events} (
  sequence BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  event_id TEXT NOT NULL CHECK (length(trim(event_id)) > 0),
  event_json JSONB NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, event_id)
);

CREATE INDEX IF NOT EXISTS ${identifier(`${runtime.prefix}_events_tenant_sequence_idx`)}
  ON ${runtime.events}(tenant_id, sequence);
CREATE INDEX IF NOT EXISTS ${identifier(`${runtime.prefix}_events_memory_idx`)}
  ON ${runtime.events}(tenant_id, ((event_json->>'memoryId')), sequence);

CREATE TABLE IF NOT EXISTS ${runtime.snapshots} (
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  snapshot_id TEXT NOT NULL CHECK (length(trim(snapshot_id)) > 0),
  captured_at TIMESTAMPTZ NOT NULL,
  snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, snapshot_id)
);
`
    },
    {
      version: 2,
      name: "tenant-rls",
      sql: `${policySql(runtime.records)}${policySql(runtime.events)}${policySql(runtime.snapshots)}`
    },
    {
      version: 3,
      name: "replay-checkpoints",
      sql: `
CREATE TABLE IF NOT EXISTS ${runtime.checkpoints} (
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  consumer_id TEXT NOT NULL CHECK (length(trim(consumer_id)) > 0),
  event_sequence BIGINT NOT NULL CHECK (event_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, consumer_id)
);
${policySql(runtime.checkpoints)}
      `
    },
    {
      version: 4,
      name: "http-idempotency",
      sql: `
CREATE TABLE IF NOT EXISTS ${runtime.idempotency} (
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0),
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  lease_token TEXT NOT NULL CHECK (length(trim(lease_token)) > 0),
  status_code INTEGER,
  response_json JSONB,
  response_headers JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(response_headers) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, operation, idempotency_key),
  CHECK ((state = 'IN_PROGRESS' AND status_code IS NULL AND response_json IS NULL) OR
         (state = 'COMPLETED' AND status_code BETWEEN 100 AND 599 AND response_json IS NOT NULL))
);
${policySql(runtime.idempotency)}
`
    }
  ];
}

function migrationBundle(prefix: string): string {
  const runtime = tables(prefix);
  const migrations = migrationSql(runtime);
  return [
    `CREATE TABLE IF NOT EXISTS ${runtime.schema} (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    ...migrations.map((migration) => `${migration.sql}\nINSERT INTO ${runtime.schema}(version) VALUES (${migration.version}) ON CONFLICT (version) DO NOTHING;`)
  ].join("\n");
}

export const POSTGRES_RUNTIME_SCHEMA_VERSION = 4 as const;
export const POSTGRES_RUNTIME_MIGRATIONS = migrationSql(tables("premise_v2"));
export const POSTGRES_RUNTIME_SCHEMA_SQL = migrationBundle("premise_v2");
export const POSTGRES_RUNTIME_SPEC_VERSION = SPEC_VERSION_V2;
const HTTP_IDEMPOTENCY_LEASE_MS = 60_000;

function cloneJson<T>(value: T): T {
  const serialized = json(value, "PREMiSE runtime value");
  return JSON.parse(serialized) as T;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("PREMiSE runtime JSON values cannot contain undefined or functions");
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function assertKey(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new TypeError(`${label} must be a non-empty string without surrounding whitespace`);
}

function assertOperation(value: string): void {
  assertKey(value, "operation");
  if (value.length > 128) throw new TypeError("operation must not exceed 128 characters");
}

function rowOptionalText(row: Readonly<Record<string, unknown>>, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`PostgreSQL row has invalid text column ${column}`);
  return value;
}

function rowStatus(row: Readonly<Record<string, unknown>>): number {
  const value = row.status_code;
  const status = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw new Error("PostgreSQL idempotency row has invalid status_code");
  return status;
}

function rowHeaders(row: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const value = jsonValue(row, "response_headers");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("PostgreSQL idempotency row has invalid response_headers");
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw new Error(`PostgreSQL idempotency response header ${key} is not a string`);
    headers[key] = item;
  }
  return headers;
}

function assertDateTime(value: string, label: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be an ISO date-time`);
}

function runtimeRecord<T>(row: Readonly<Record<string, unknown>>): RuntimeRecord<T> {
  return {
    envelope: parseMemoryEnvelopeV2(jsonValue(row, "envelope_json")),
    content: cloneJson(jsonValue(row, "content_json")) as T
  };
}

function runtimeEvent(row: Readonly<Record<string, unknown>>): V2Event {
  return parseV2Event(jsonValue(row, "event_json"));
}

function runtimeSnapshot<T>(row: Readonly<Record<string, unknown>>): RuntimeSnapshot<T> {
  const snapshot = jsonValue(row, "snapshot_json");
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("PostgreSQL row has an invalid PREMiSE snapshot");
  return validateSnapshot<T>(snapshot);
}

function validateSnapshot<T>(input: unknown): RuntimeSnapshot<T> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Unsupported PREMiSE runtime snapshot");
  const snapshot = input as Partial<RuntimeSnapshot<T>>;
  if (snapshot.format !== "premise-runtime-snapshot" || snapshot.version !== 1 || typeof snapshot.capturedAt !== "string") throw new TypeError("Unsupported PREMiSE runtime snapshot");
  assertDateTime(snapshot.capturedAt, "snapshot.capturedAt");
  if (!Array.isArray(snapshot.records) || !Array.isArray(snapshot.events)) throw new TypeError("PREMiSE runtime snapshot records and events must be arrays");
  const records = snapshot.records.map((record) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) throw new TypeError("PREMiSE runtime snapshot contains an invalid record");
    const value = record as RuntimeRecord<T>;
    return { envelope: parseMemoryEnvelopeV2(value.envelope), content: cloneJson(value.content) };
  });
  const events = snapshot.events.map((event) => parseV2Event(event));
  return { format: "premise-runtime-snapshot", version: 1, capturedAt: snapshot.capturedAt, records, events };
}

function rowEventId(row: Readonly<Record<string, unknown>>): string {
  return rowText(row, "event_id");
}

export class PostgresRuntimeStore<T = unknown> implements AsyncRuntimeStore<T> {
  readonly client: PostgresAdapter;
  readonly tablePrefix: string;
  readonly tenantId: string | undefined;
  private readonly runtime: RuntimeTables;
  private readonly migrations: readonly PostgresRuntimeMigration[];
  private readonly ready: Promise<void>;
  private closed = false;

  constructor(client: PostgresAdapter, tablePrefixOrOptions: string | PostgresRuntimeStoreOptions = "premise_v2") {
    if (client === null || typeof client !== "object" || typeof client.query !== "function") throw new TypeError("PostgresClient must provide query(sql, values)");
    const options = typeof tablePrefixOrOptions === "string" ? { tablePrefix: tablePrefixOrOptions } : tablePrefixOrOptions;
    this.client = client;
    this.tablePrefix = options.tablePrefix ?? "premise_v2";
    this.runtime = tables(this.tablePrefix);
    this.migrations = migrationSql(this.runtime);
    if (options.tenantId !== undefined) assertTenantId(options.tenantId);
    this.tenantId = options.tenantId;
    this.ready = options.autoMigrate === true ? this.runMigrations() : Promise.resolve();
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

  async get(memoryId: string): Promise<RuntimeRecord<T> | undefined> {
    assertKey(memoryId, "memoryId");
    return this.scoped(async (client) => {
      const query = this.tenantId === undefined
        ? `SELECT envelope_json::text AS envelope_json, content_json::text AS content_json FROM ${this.runtime.records} WHERE memory_id = $1`
        : `SELECT envelope_json::text AS envelope_json, content_json::text AS content_json FROM ${this.runtime.records} WHERE tenant_id = $1 AND memory_id = $2`;
      const result = await client.query(query, this.tenantId === undefined ? [memoryId] : [this.tenantId, memoryId]);
      const row = result.rows[0];
      return row === undefined ? undefined : cloneJson(runtimeRecord<T>(row));
    });
  }

  async list(): Promise<readonly RuntimeRecord<T>[]> {
    return this.scoped(async (client) => {
      const result = this.tenantId === undefined
        ? await client.query(`SELECT envelope_json::text AS envelope_json, content_json::text AS content_json FROM ${this.runtime.records} ORDER BY tenant_id, memory_id`)
        : await client.query(`SELECT envelope_json::text AS envelope_json, content_json::text AS content_json FROM ${this.runtime.records} WHERE tenant_id = $1 ORDER BY memory_id`, [this.tenantId]);
      return result.rows.map((row) => cloneJson(runtimeRecord<T>(row)));
    });
  }

  async put(record: RuntimeRecord<T>): Promise<void> {
    const envelope = parseMemoryEnvelopeV2(cloneJson(record.envelope));
    this.assertTenant(envelope.tenantId);
    await this.scoped((client) => this.putOn(client, { envelope, content: cloneJson(record.content) }));
  }

  async putAndAppend(record: RuntimeRecord<T>, event: V2Event): Promise<void> {
    const checkedRecord = { envelope: parseMemoryEnvelopeV2(cloneJson(record.envelope)), content: cloneJson(record.content) };
    const checkedEvent = parseV2Event(cloneJson(event));
    this.assertTenant(checkedRecord.envelope.tenantId);
    this.assertTenant(checkedEvent.tenantId);
    if (checkedEvent.memoryId !== undefined && checkedEvent.memoryId !== checkedRecord.envelope.memoryId) throw new Error("Runtime event memory ID does not match record");
    await this.transaction(async (client) => {
      await this.putOn(client, checkedRecord, checkedEvent.type === "MemoryRegistered" || checkedEvent.type === "MemoryDerived");
      await this.appendEventOn(client, checkedEvent);
    });
  }

  async appendEvent(event: V2Event): Promise<void> {
    const parsed = parseV2Event(cloneJson(event));
    this.assertTenant(parsed.tenantId);
    await this.scoped((client) => this.appendEventOn(client, parsed));
  }

  async appendEvents(events: readonly V2Event[]): Promise<void> {
    const parsed = events.map((event) => parseV2Event(cloneJson(event)));
    for (const event of parsed) this.assertTenant(event.tenantId);
    if (parsed.length === 0) return;
    await this.transaction(async (client) => {
      for (const event of parsed) await this.appendEventOn(client, event);
    });
  }

  async claimHttpIdempotency(input: HttpIdempotencyRequest): Promise<HttpIdempotencyClaim> {
    this.validateHttpIdempotencyRequest(input);
    const token = randomUUID();
    return this.httpTransaction(input.tenantId, async (client) => {
      const inserted = await client.query<Readonly<Record<string, unknown>>>(`
        INSERT INTO ${this.runtime.idempotency}(
          tenant_id, operation, idempotency_key, request_hash, state, lease_token,
          status_code, response_json, response_headers, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5, NULL, NULL, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING
        RETURNING lease_token
      `, [input.tenantId, input.operation, input.key, input.requestHash, token]);
      if (inserted.rows.length > 0) return { kind: "new", token };

      const existing = await client.query<Readonly<Record<string, unknown>>>(`
        SELECT request_hash, state, lease_token, status_code, response_json::text AS response_json,
               response_headers::text AS response_headers, updated_at::text AS updated_at
        FROM ${this.runtime.idempotency}
        WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3
        FOR UPDATE
      `, [input.tenantId, input.operation, input.key]);
      const row = existing.rows[0];
      if (row === undefined) throw new Error(`HTTP idempotency claim was not stored: ${input.key}`);
      if (rowText(row, "request_hash") !== input.requestHash) return { kind: "conflict" };
      const state = rowText(row, "state");
      if (state === "COMPLETED") {
        return {
          kind: "replay",
          response: {
            status: rowStatus(row),
            body: cloneJson(jsonValue(row, "response_json")),
            headers: rowHeaders(row)
          }
        };
      }
      if (state !== "IN_PROGRESS") throw new Error(`PostgreSQL idempotency row has invalid state: ${state}`);
      const updatedAt = Date.parse(rowText(row, "updated_at"));
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt <= HTTP_IDEMPOTENCY_LEASE_MS) return { kind: "in-progress" };
      await client.query(`
        UPDATE ${this.runtime.idempotency}
        SET lease_token = $4, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3
      `, [input.tenantId, input.operation, input.key, token]);
      return { kind: "new", token };
    });
  }

  async completeHttpIdempotency(input: HttpIdempotencyCompletion): Promise<void> {
    this.validateHttpIdempotencyRequest(input);
    if (!Number.isSafeInteger(input.response.status) || input.response.status < 100 || input.response.status > 599) throw new TypeError("HTTP idempotency response status must be from 100 to 599");
    await this.httpTransaction(input.tenantId, async (client) => {
      const result = await client.query(`
        UPDATE ${this.runtime.idempotency}
        SET state = 'COMPLETED', status_code = $5, response_json = $6::jsonb,
            response_headers = $7::jsonb, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3
          AND request_hash = $4 AND state = 'IN_PROGRESS' AND lease_token = $8
      `, [input.tenantId, input.operation, input.key, input.requestHash, input.response.status, json(input.response.body), json(input.response.headers ?? {}), input.token]);
      if ((result.rowCount ?? result.rows.length) === 1) return;
      const existing = await client.query(`
        SELECT state, request_hash, lease_token
        FROM ${this.runtime.idempotency}
        WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3
      `, [input.tenantId, input.operation, input.key]);
      const row = existing.rows[0];
      if (row !== undefined && rowText(row, "state") === "COMPLETED" && rowText(row, "request_hash") === input.requestHash) return;
      throw new Error(`HTTP idempotency claim is no longer owned: ${input.key}`);
    });
  }

  async releaseHttpIdempotency(input: HttpIdempotencyRelease): Promise<void> {
    this.validateHttpIdempotencyRequest(input);
    await this.httpTransaction(input.tenantId, async (client) => {
      await client.query(`
        DELETE FROM ${this.runtime.idempotency}
        WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3
          AND request_hash = $4 AND state = 'IN_PROGRESS' AND lease_token = $5
      `, [input.tenantId, input.operation, input.key, input.requestHash, input.token]);
    });
  }

  async hasEvent(idempotencyKey: string): Promise<boolean> {
    assertKey(idempotencyKey, "idempotencyKey");
    return this.scoped(async (client) => {
      const query = this.tenantId === undefined
        ? `SELECT 1 AS present FROM ${this.runtime.events} WHERE idempotency_key = $1`
        : `SELECT 1 AS present FROM ${this.runtime.events} WHERE tenant_id = $1 AND idempotency_key = $2`;
      const result = await client.query(query, this.tenantId === undefined ? [idempotencyKey] : [this.tenantId, idempotencyKey]);
      return result.rows.length > 0;
    });
  }

  async listEvents(): Promise<readonly V2Event[]> {
    return this.scoped(async (client) => {
      const result = this.tenantId === undefined
        ? await client.query(`SELECT event_json::text AS event_json FROM ${this.runtime.events} ORDER BY sequence`)
        : await client.query(`SELECT event_json::text AS event_json FROM ${this.runtime.events} WHERE tenant_id = $1 ORDER BY sequence`, [this.tenantId]);
      return result.rows.map((row) => cloneJson(runtimeEvent(row)));
    });
  }

  async snapshot(capturedAt: string): Promise<RuntimeSnapshot<T>> {
    assertDateTime(capturedAt, "capturedAt");
    return this.transaction(async (client) => {
      const records = await this.listOn(client);
      const events = await this.listEventsOn(client);
      const snapshot = validateSnapshot<T>({ format: "premise-runtime-snapshot", version: 1, capturedAt, records, events });
      await this.saveSnapshotOn(client, snapshot);
      return cloneJson(snapshot);
    }, { isolation: "repeatable read" });
  }

  async saveSnapshot(snapshot: RuntimeSnapshot<T>): Promise<void> {
    const checked = this.checkedSnapshot(snapshot);
    await this.scoped((client) => this.saveSnapshotOn(client, checked));
  }

  async getSnapshot(capturedAt: string): Promise<RuntimeSnapshot<T> | undefined> {
    assertDateTime(capturedAt, "capturedAt");
    return this.scoped(async (client) => {
      const snapshotTenant = this.snapshotTenant();
      const result = await client.query(`
        SELECT snapshot_json::text AS snapshot_json
        FROM ${this.runtime.snapshots}
        WHERE tenant_id = $1 AND snapshot_id = $2
      `, [snapshotTenant, capturedAt]);
      const row = result.rows[0];
      return row === undefined ? undefined : cloneJson(runtimeSnapshot<T>(row));
    });
  }

  async restore(snapshot: RuntimeSnapshot<T>): Promise<void> {
    const checked = this.checkedSnapshot(snapshot);
    await this.transaction(async (client) => {
      if (this.tenantId === undefined) {
        await client.query(`DELETE FROM ${this.runtime.events}`);
        await client.query(`DELETE FROM ${this.runtime.records}`);
        await client.query(`DELETE FROM ${this.runtime.snapshots}`);
        await client.query(`DELETE FROM ${this.runtime.checkpoints}`);
      } else {
        await client.query(`DELETE FROM ${this.runtime.events} WHERE tenant_id = $1`, [this.tenantId]);
        await client.query(`DELETE FROM ${this.runtime.records} WHERE tenant_id = $1`, [this.tenantId]);
        await client.query(`DELETE FROM ${this.runtime.snapshots} WHERE tenant_id = $1`, [this.snapshotTenant()]);
        await client.query(`DELETE FROM ${this.runtime.checkpoints} WHERE tenant_id = $1`, [this.tenantId]);
      }
      for (const record of checked.records) await this.putOn(client, record);
      for (const event of checked.events) await this.appendEventOn(client, event);
      await this.saveSnapshotOn(client, checked);
    });
  }

  async replay(handler: PostgresReplayHandler, options: PostgresReplayOptions = {}): Promise<number> {
    if (typeof handler !== "function") throw new TypeError("replay handler must be a function");
    const consumerId = options.consumerId ?? "default";
    assertKey(consumerId, "consumerId");
    const tenantId = options.tenantId ?? this.tenantId;
    if (tenantId !== undefined) {
      assertTenantId(tenantId);
      if (this.tenantId !== undefined && tenantId !== this.tenantId) throw new Error(`Tenant boundary violation: ${tenantId}`);
    }
    const batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new TypeError("batchSize must be an integer between 1 and 1000");
    const fromSequence = options.fromSequence ?? 0;
    if (!Number.isSafeInteger(fromSequence) || fromSequence < 0) throw new TypeError("fromSequence must be a non-negative safe integer");
    await this.prepare();
    let processed = 0;
    let firstBatch = true;
    while (true) {
      const count = await withPostgresTransaction(this.client, async (client) => {
        if (tenantId !== undefined) await setTenantContext(client, tenantId);
        const checkpointTenant = tenantId ?? "__all__";
        await client.query(`
          INSERT INTO ${this.runtime.checkpoints}(tenant_id, consumer_id, event_sequence)
          VALUES ($1, $2, $3)
          ON CONFLICT (tenant_id, consumer_id) DO NOTHING
        `, [checkpointTenant, consumerId, firstBatch ? fromSequence : 0]);
        const checkpoint = await client.query(`
          SELECT event_sequence
          FROM ${this.runtime.checkpoints}
          WHERE tenant_id = $1 AND consumer_id = $2
          FOR UPDATE
        `, [checkpointTenant, consumerId]);
        const cursor = Math.max(fromSequence, rowSequence(checkpoint.rows[0] ?? {}, "event_sequence"));
        const eventResult = tenantId === undefined
          ? await client.query(`SELECT sequence, event_json::text AS event_json FROM ${this.runtime.events} WHERE sequence > $1 ORDER BY sequence LIMIT $2`, [cursor, batchSize])
          : await client.query(`SELECT sequence, event_json::text AS event_json FROM ${this.runtime.events} WHERE tenant_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3`, [tenantId, cursor, batchSize]);
        if (eventResult.rows.length === 0) return 0;
        let lastSequence = cursor;
        for (const row of eventResult.rows) {
          const sequence = rowSequence(row, "sequence");
          await handler(runtimeEvent(row), sequence);
          lastSequence = sequence;
        }
        await client.query(`
          UPDATE ${this.runtime.checkpoints}
          SET event_sequence = $3, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND consumer_id = $2
        `, [checkpointTenant, consumerId, lastSequence]);
        return eventResult.rows.length;
      });
      firstBatch = false;
      processed += count;
      if (count === 0) return processed;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.ready;
    } finally {
      this.closed = true;
      await this.client.close?.();
    }
  }

  private async runMigrations(): Promise<void> {
    await withPostgresTransaction(this.client, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`premise-runtime:${this.tablePrefix}`]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.runtime.schema} (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const appliedResult = await client.query(`SELECT version FROM ${this.runtime.schema} ORDER BY version`);
      const applied = new Set(appliedResult.rows.map((row) => rowSequence(row, "version")));
      const latest = Math.max(...this.migrations.map((migration) => migration.version));
      if ([...applied].some((version) => version > latest)) throw new Error(`PostgreSQL runtime schema is newer than this package (latest supported: ${latest})`);
      for (const migration of this.migrations) {
        if (applied.has(migration.version)) continue;
        await client.query(migration.sql);
        await client.query(`INSERT INTO ${this.runtime.schema}(version) VALUES ($1)`, [migration.version]);
      }
    });
  }

  private async prepare(): Promise<void> {
    this.ensureOpen();
    await this.ready;
  }

  private async scoped<T>(action: (client: PostgresAdapter) => Promise<T>): Promise<T> {
    await this.prepare();
    if (this.tenantId === undefined) return action(this.client);
    return this.transaction(async (client) => action(client));
  }

  private async transaction<T>(action: (client: PostgresAdapter) => Promise<T>, options: { readonly isolation?: "read committed" | "repeatable read" | "serializable"; readonly readOnly?: boolean } = {}): Promise<T> {
    await this.prepare();
    return withPostgresTransaction(this.client, async (client) => {
      if (this.tenantId !== undefined) await setTenantContext(client, this.tenantId);
      return action(client);
    }, options);
  }

  private async httpTransaction<T>(tenantId: string, action: (client: PostgresAdapter) => Promise<T>): Promise<T> {
    assertTenantId(tenantId);
    this.assertTenant(tenantId);
    return this.transaction(async (client) => {
      if (this.tenantId === undefined) await setTenantContext(client, tenantId);
      return action(client);
    });
  }

  private validateHttpIdempotencyRequest(input: HttpIdempotencyRequest): void {
    assertTenantId(input.tenantId);
    this.assertTenant(input.tenantId);
    assertOperation(input.operation);
    assertKey(input.key, "idempotency key");
    if (input.key.length > 256) throw new TypeError("idempotency key must not exceed 256 characters");
    assertKey(input.requestHash, "request hash");
  }

  private async putOn(client: PostgresAdapter, record: RuntimeRecord<T>, insertOnly = false): Promise<void> {
    const result = await client.query(`
      INSERT INTO ${this.runtime.records}(tenant_id, memory_id, envelope_json, content_json)
      VALUES ($1, $2, $3::jsonb, $4::jsonb)
      ${insertOnly ? "ON CONFLICT (tenant_id, memory_id) DO NOTHING" : `ON CONFLICT (tenant_id, memory_id) DO UPDATE SET
        envelope_json = EXCLUDED.envelope_json,
        content_json = EXCLUDED.content_json,
        updated_at = CURRENT_TIMESTAMP`}
      ${insertOnly ? "RETURNING memory_id" : ""}
    `, [record.envelope.tenantId, record.envelope.memoryId, json(record.envelope), json(record.content)]);
    if (insertOnly && result.rows.length === 0) throw new Error(`Memory already registered: ${record.envelope.memoryId}`);
  }

  private async appendEventOn(client: PostgresAdapter, parsed: V2Event): Promise<void> {
    const serialized = json(parsed);
    const result = await client.query<Readonly<Record<string, unknown>>>(`
      INSERT INTO ${this.runtime.events}(tenant_id, idempotency_key, event_id, event_json, occurred_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING event_id, event_json::text AS event_json
    `, [parsed.tenantId, parsed.idempotencyKey, parsed.eventId, serialized, parsed.occurredAt]);
    if (result.rows.length > 0) return;
    const existing = await client.query<Readonly<Record<string, unknown>>>(`
      SELECT event_id, event_json::text AS event_json
      FROM ${this.runtime.events}
      WHERE tenant_id = $1 AND idempotency_key = $2
    `, [parsed.tenantId, parsed.idempotencyKey]);
    const row = existing.rows[0];
    if (row === undefined) throw new Error(`Idempotency event was not stored: ${parsed.idempotencyKey}`);
    const existingEvent = runtimeEvent(row);
    if (rowEventId(row) !== parsed.eventId || !sameJson(existingEvent, parsed)) throw new Error(`Conflicting idempotency key: ${parsed.idempotencyKey}`);
  }

  private async listOn(client: PostgresAdapter): Promise<readonly RuntimeRecord<T>[]> {
      const result = this.tenantId === undefined
      ? await client.query(`SELECT envelope_json::text AS envelope_json, content_json::text AS content_json FROM ${this.runtime.records} ORDER BY tenant_id, memory_id`)
      : await client.query(`SELECT envelope_json::text AS envelope_json, content_json::text AS content_json FROM ${this.runtime.records} WHERE tenant_id = $1 ORDER BY memory_id`, [this.tenantId]);
    return result.rows.map((row) => cloneJson(runtimeRecord<T>(row)));
  }

  private async listEventsOn(client: PostgresAdapter): Promise<readonly V2Event[]> {
      const result = this.tenantId === undefined
      ? await client.query(`SELECT event_json::text AS event_json FROM ${this.runtime.events} ORDER BY sequence`)
      : await client.query(`SELECT event_json::text AS event_json FROM ${this.runtime.events} WHERE tenant_id = $1 ORDER BY sequence`, [this.tenantId]);
    return result.rows.map((row) => cloneJson(runtimeEvent(row)));
  }

  private async saveSnapshotOn(client: PostgresAdapter, snapshot: RuntimeSnapshot<T>): Promise<void> {
    await client.query(`
      INSERT INTO ${this.runtime.snapshots}(tenant_id, snapshot_id, captured_at, snapshot_json)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (tenant_id, snapshot_id) DO UPDATE SET
        captured_at = EXCLUDED.captured_at,
        snapshot_json = EXCLUDED.snapshot_json
    `, [this.snapshotTenant(), snapshot.capturedAt, snapshot.capturedAt, json(snapshot)]);
  }

  private checkedSnapshot(snapshot: RuntimeSnapshot<T>): RuntimeSnapshot<T> {
    const checked = validateSnapshot<T>(cloneJson(snapshot));
    for (const record of checked.records) this.assertTenant(record.envelope.tenantId);
    for (const event of checked.events) this.assertTenant(event.tenantId);
    return checked;
  }

  private snapshotTenant(): string {
    return this.tenantId ?? "__all__";
  }

  private assertTenant(tenantId: string): void {
    if (this.tenantId !== undefined && tenantId !== this.tenantId) throw new Error(`Tenant boundary violation: ${tenantId}`);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("PostgresRuntimeStore is closed");
  }
}

export function openPostgresRuntimeStore<T = unknown>(client: PostgresAdapter, options: PostgresRuntimeStoreOptions = {}): PostgresRuntimeStore<T> {
  return new PostgresRuntimeStore<T>(client, options);
}

export * from "./persistent.js";
