import { createHash, randomUUID } from "node:crypto";
import { parseMemoryEnvelopeV2, parseV2Event, SPEC_VERSION_V2, type V2Event } from "@premise/protocol-types";
import type { V2SignatureReplayClaim, V2SignatureReplayStoreAsync } from "@premise/protocol-types";
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

export interface PostgresSignatureReplayStoreOptions {
  readonly tablePrefix?: string;
  readonly tenantId: string;
  /** Retention used by callers that omit an explicit claim expiry. */
  readonly retentionMs?: number;
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

export interface HttpIdempotencyPruneOptions {
  /** Completed responses older than this duration are removed. */
  readonly maxAgeMs?: number;
  /** Abandoned in-progress claims older than this duration are removed. */
  readonly inProgressMaxAgeMs?: number;
  readonly limit?: number;
}

export interface PostgresReplayOptions {
  readonly consumerId?: string;
  readonly tenantId?: string;
  readonly batchSize?: number;
  readonly fromSequence?: number;
}

export type PostgresReplayHandler = (event: V2Event, sequence: number) => Promise<void> | void;

export interface PostgresRuntimeLoadOptions<T = unknown> {
  /** Maximum number of rows materialized per database page. */
  readonly batchSize?: number;
  readonly onRecord: (record: RuntimeRecord<T>) => Promise<void> | void;
  readonly onEvent: (event: V2Event, sequence: number) => Promise<void> | void;
}

export interface PostgresRuntimeLoadResult {
  readonly records: number;
  readonly events: number;
}

export interface PostgresRuntimeRestoreSink<T = unknown> {
  readonly onRecord: (record: RuntimeRecord<T>) => Promise<void>;
  readonly onEvent: (event: V2Event) => Promise<void>;
}

export interface PostgresRuntimeRestoreSourceResult {
  readonly capturedAt: string;
  readonly records: number;
  readonly events: number;
}

export interface PostgresRuntimeRestoreOptions<T = unknown> {
  readonly source: (sink: PostgresRuntimeRestoreSink<T>) => Promise<PostgresRuntimeRestoreSourceResult>;
}

export interface PostgresRuntimeCounts {
  readonly memories: number;
  readonly events: number;
}

export interface PostgresRuntimeSearchOptions {
  readonly limit?: number;
  /** Maximum number of FTS matches materialized before ranking. */
  readonly candidateLimit?: number;
  readonly filter?: unknown;
  readonly filters?: unknown;
  readonly lexicalWeight?: number;
  readonly vectorWeight?: number;
  readonly minScore?: number;
}

export interface PostgresRuntimeSearchHit<T = unknown> {
  readonly id: string;
  readonly text: string;
  readonly content: T;
  readonly metadata: Readonly<Record<string, string>>;
  readonly document: {
    readonly id: string;
    readonly text: string;
    readonly content: T;
    readonly metadata: Readonly<Record<string, string>>;
  };
  readonly score: number;
  readonly lexicalScore: number;
  readonly vectorScore: 0;
  readonly record: RuntimeRecord<T>;
  readonly explanation: Readonly<Record<string, unknown>>;
}

export interface PostgresLexicalIndexOptions {
  readonly awaitDurability?: () => void | Promise<void>;
}

interface RuntimeTables {
  readonly prefix: string;
  readonly schema: string;
  readonly records: string;
  readonly events: string;
  readonly snapshots: string;
  readonly checkpoints: string;
  readonly idempotency: string;
  readonly signatureReplays: string;
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
    idempotency: identifier(`${prefix}_http_idempotency`),
    signatureReplays: identifier(`${prefix}_signature_replays`)
  };
}

function migrationSql(runtime: RuntimeTables): readonly PostgresRuntimeMigration[] {
  const policy = (table: string): string => `${runtime.prefix}_${table}_tenant_policy`;
  const policySql = (table: string): string => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${identifier(policy(table.replaceAll('"', "").replace(`${runtime.prefix}_`, "")))} ON ${table};
CREATE POLICY ${identifier(policy(table.replaceAll('"', "").replace(`${runtime.prefix}_`, "")))} ON ${table}
  AS PERMISSIVE
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
    },
    {
      version: 5,
      name: "tenant-rls-permissive",
      sql: `${policySql(runtime.records)}${policySql(runtime.events)}${policySql(runtime.snapshots)}${policySql(runtime.checkpoints)}${policySql(runtime.idempotency)}`
    },
    {
      version: 6,
      name: "lexical-retrieval",
      sql: `
CREATE INDEX IF NOT EXISTS ${identifier(`${runtime.prefix}_records_content_fts_idx`)}
  ON ${runtime.records} USING GIN (to_tsvector('simple', content_json::text));
      `
    },
    {
      version: 7,
      name: "signature-replay",
      sql: `
CREATE TABLE IF NOT EXISTS ${runtime.signatureReplays} (
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  replay_digest TEXT NOT NULL CHECK (replay_digest ~ '^[0-9a-f]{64}$'),
  signature_id TEXT NOT NULL CHECK (length(trim(signature_id)) > 0),
  key_id TEXT NOT NULL CHECK (length(trim(key_id)) > 0),
  signed_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > accepted_at),
  PRIMARY KEY (tenant_id, replay_digest)
);

CREATE INDEX IF NOT EXISTS ${identifier(`${runtime.prefix}_signature_replays_expiry_idx`)}
  ON ${runtime.signatureReplays}(tenant_id, expires_at);
${policySql(runtime.signatureReplays)}
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

export const POSTGRES_RUNTIME_SCHEMA_VERSION = 7 as const;
export const POSTGRES_RUNTIME_MIGRATIONS = migrationSql(tables("premise_v2"));
export const POSTGRES_RUNTIME_SCHEMA_SQL = migrationBundle("premise_v2");
export const POSTGRES_RUNTIME_SPEC_VERSION = SPEC_VERSION_V2;
const HTTP_IDEMPOTENCY_LEASE_MS = 60_000;
export const DEFAULT_POSTGRES_RUNTIME_LOAD_BATCH_SIZE = 1_000;
export const MAX_POSTGRES_RUNTIME_LOAD_BATCH_SIZE = 10_000;
export const DEFAULT_POSTGRES_RUNTIME_SEARCH_LIMIT = 10;
export const MAX_POSTGRES_RUNTIME_SEARCH_LIMIT = 1_000;
export const DEFAULT_POSTGRES_RUNTIME_SEARCH_CANDIDATE_LIMIT = 100;
export const MAX_POSTGRES_RUNTIME_SEARCH_CANDIDATE_LIMIT = 10_000;

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

function loadBatchSize(value: number | undefined): number {
  const result = value ?? DEFAULT_POSTGRES_RUNTIME_LOAD_BATCH_SIZE;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_POSTGRES_RUNTIME_LOAD_BATCH_SIZE) {
    throw new TypeError(`load batchSize must be an integer between 1 and ${MAX_POSTGRES_RUNTIME_LOAD_BATCH_SIZE}`);
  }
  return result;
}

function searchLimit(value: number | undefined): number {
  const result = value ?? DEFAULT_POSTGRES_RUNTIME_SEARCH_LIMIT;
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_POSTGRES_RUNTIME_SEARCH_LIMIT) {
    throw new TypeError(`search limit must be an integer between 0 and ${MAX_POSTGRES_RUNTIME_SEARCH_LIMIT}`);
  }
  return result;
}

function searchCandidateLimit(value: number | undefined, resultLimit: number): number {
  const result = value ?? Math.min(MAX_POSTGRES_RUNTIME_SEARCH_CANDIDATE_LIMIT, Math.max(DEFAULT_POSTGRES_RUNTIME_SEARCH_CANDIDATE_LIMIT, resultLimit * 10));
  if (!Number.isSafeInteger(result) || result < Math.max(1, resultLimit) || result > MAX_POSTGRES_RUNTIME_SEARCH_CANDIDATE_LIMIT) {
    throw new TypeError(`search candidateLimit must be an integer between ${Math.max(1, resultLimit)} and ${MAX_POSTGRES_RUNTIME_SEARCH_CANDIDATE_LIMIT}`);
  }
  return result;
}

function searchWeight(value: number | undefined, label: string, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0) throw new RangeError(`${label} must be a finite non-negative number`);
  return result;
}

function searchScope(
  options: PostgresRuntimeSearchOptions,
  configuredTenantId: string | undefined
): { readonly tenantId: string | undefined; readonly filterApplied: boolean; readonly matches: boolean } {
  if (options.filter !== undefined && options.filters !== undefined) throw new TypeError("Use either filter or filters, not both");
  const filter = options.filter ?? options.filters;
  if (filter === undefined) return { tenantId: configuredTenantId, filterApplied: false, matches: true };
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) throw new TypeError("PostgreSQL lexical filter must be an object");
  const entries = Object.entries(filter as Record<string, unknown>);
  if (entries.some(([key]) => key !== "tenantId")) return { tenantId: configuredTenantId, filterApplied: true, matches: false };
  const requestedTenantId = (filter as Record<string, unknown>).tenantId;
  if (requestedTenantId === undefined) return { tenantId: configuredTenantId, filterApplied: true, matches: true };
  if (typeof requestedTenantId !== "string" || requestedTenantId.length === 0 || requestedTenantId.trim() !== requestedTenantId) {
    throw new TypeError("PostgreSQL lexical search requires an exact tenantId filter");
  }
  return {
    tenantId: requestedTenantId,
    filterApplied: true,
    matches: configuredTenantId === undefined || configuredTenantId === requestedTenantId
  };
}

function lexicalTokens(query: string): readonly string[] {
  const normalized = query.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "");
  return [...new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? [])];
}

function rowNumber(row: Readonly<Record<string, unknown>>, column: string): number {
  const value = row[column];
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : typeof value === "bigint" ? Number(value) : Number.NaN;
  if (!Number.isFinite(result)) throw new Error(`PostgreSQL row has invalid numeric column ${column}`);
  return result;
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

/**
 * Durable, tenant-scoped replay protection for signed v2 envelopes.
 *
 * The signature itself is never persisted. A SHA-256 digest is claimed with
 * an atomic INSERT/ON CONFLICT operation inside a transaction, so concurrent
 * API replicas cannot accept the same signature twice.
 */
export class PostgresSignatureReplayStore implements V2SignatureReplayStoreAsync {
  readonly client: PostgresAdapter;
  readonly tablePrefix: string;
  readonly tenantId: string;
  private readonly table: string;
  private readonly retentionMs: number;

  constructor(client: PostgresAdapter, options: PostgresSignatureReplayStoreOptions) {
    if (client === null || typeof client !== "object" || typeof client.query !== "function") throw new TypeError("PostgresClient must provide query(sql, values)");
    if (options === null || typeof options !== "object") throw new TypeError("Postgres signature replay options are required");
    assertTenantId(options.tenantId);
    const tablePrefix = options.tablePrefix ?? "premise_v2";
    const configuredRetention = options.retentionMs ?? 10 * 60 * 1_000;
    if (!Number.isSafeInteger(configuredRetention) || configuredRetention < 1_000 || configuredRetention > 24 * 60 * 60 * 1_000) throw new TypeError("signature replay retentionMs must be between 1000 and 86400000");
    this.client = client;
    this.tablePrefix = tablePrefix;
    this.tenantId = options.tenantId;
    this.table = tables(tablePrefix).signatureReplays;
    this.retentionMs = configuredRetention;
  }

  /** Fail closed when deployment migrations did not create the replay table. */
  async initialize(): Promise<void> {
    const result = await this.client.query(`
      SELECT
        to_regclass($1)::text AS relation,
        c.relrowsecurity AS row_security,
        c.relforcerowsecurity AS force_row_security,
        EXISTS (
          SELECT 1
          FROM pg_policies p
          WHERE p.schemaname = n.nspname
            AND p.tablename = $2
            AND p.policyname = $3
            AND p.qual LIKE '%premise.tenant_id%'
            AND p.with_check LIKE '%premise.tenant_id%'
        ) AS tenant_policy
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass($1)
    `, [`${this.tablePrefix}_signature_replays`, `${this.tablePrefix}_signature_replays`, `${this.tablePrefix}_signature_replays_tenant_policy`]);
    const row = result.rows[0];
    if (row?.relation !== `${this.tablePrefix}_signature_replays`) throw new Error(`PostgreSQL signature replay table is missing: ${this.tablePrefix}_signature_replays`);
    if (row.row_security !== true || row.force_row_security !== true || row.tenant_policy !== true) throw new Error(`PostgreSQL signature replay table is not protected by the expected tenant RLS policy: ${this.tablePrefix}_signature_replays`);
  }

  async claim(claim: V2SignatureReplayClaim): Promise<boolean> {
    return this.claimMany([claim]);
  }

  async claimMany(claims: readonly V2SignatureReplayClaim[]): Promise<boolean> {
    if (!Array.isArray(claims)) throw new TypeError("signature replay claims must be an array");
    if (claims.length === 0) return true;
    const normalized = claims.map((claim) => this.normalizeClaim(claim));
    if (new Set(normalized.map(({ replayDigest }) => replayDigest)).size !== normalized.length) return false;
    return withPostgresTransaction(this.client, async (client) => {
      await setTenantContext(client, this.tenantId);
      await client.query(`DELETE FROM ${this.table} WHERE tenant_id = $1 AND expires_at <= CURRENT_TIMESTAMP`, [this.tenantId]);
      for (const claim of normalized) {
        const result = await client.query(`
          INSERT INTO ${this.table} (tenant_id, replay_digest, signature_id, key_id, signed_at, accepted_at, expires_at)
          VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz)
          ON CONFLICT (tenant_id, replay_digest) DO NOTHING
        `, [this.tenantId, claim.replayDigest, claim.signatureId, claim.keyId, claim.signedAt, claim.acceptedAt, claim.expiresAt]);
        if ((result.rowCount ?? result.rows.length) !== 1) throw new ReplayClaimConflict();
      }
      return true;
    }).catch((error) => {
      if (error instanceof ReplayClaimConflict) return false;
      throw error;
    });
  }

  private normalizeClaim(claim: V2SignatureReplayClaim): V2SignatureReplayClaim & { readonly replayDigest: string } {
    if (claim === null || typeof claim !== "object") throw new TypeError("signature replay claim is required");
    if (claim.tenantId !== this.tenantId) throw new Error("signature replay claim tenant does not match the store");
    for (const [label, value] of Object.entries({ key: claim.key, signatureId: claim.signatureId, keyId: claim.keyId, signedAt: claim.signedAt, acceptedAt: claim.acceptedAt, expiresAt: claim.expiresAt })) {
      assertKey(value, `signature replay ${label}`);
    }
    const signedAt = Date.parse(claim.signedAt);
    const acceptedAt = Date.parse(claim.acceptedAt);
    const expiresAt = Date.parse(claim.expiresAt);
    if (![signedAt, acceptedAt, expiresAt].every(Number.isFinite) || expiresAt <= acceptedAt || expiresAt - acceptedAt > this.retentionMs) throw new TypeError("signature replay claim timestamps are invalid or exceed retention");
    return { ...claim, replayDigest: createHash("sha256").update(claim.key, "utf8").digest("hex") };
  }
}

class ReplayClaimConflict extends Error {
  constructor() {
    super("signature replay claim already exists");
    this.name = "ReplayClaimConflict";
  }
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

  async counts(): Promise<PostgresRuntimeCounts> {
    return this.scoped(async (client) => {
      const recordsFilter = this.tenantId === undefined ? "" : " WHERE tenant_id = $1";
      const eventsFilter = this.tenantId === undefined ? "" : " WHERE tenant_id = $1";
      const result = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM ${this.runtime.records}${recordsFilter}) AS memories,
          (SELECT COUNT(*) FROM ${this.runtime.events}${eventsFilter}) AS events
      `, this.tenantId === undefined ? [] : [this.tenantId]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("PostgreSQL count query returned no row");
      return { memories: rowSequence(row, "memories"), events: rowSequence(row, "events") };
    });
  }

  async search(query: string, options: PostgresRuntimeSearchOptions = {}): Promise<readonly PostgresRuntimeSearchHit<T>[]> {
    if (typeof query !== "string") throw new TypeError("Search query must be a string");
    if (options === null || typeof options !== "object") throw new TypeError("Search options must be an object");
    const limit = searchLimit(options.limit);
    const candidateLimit = searchCandidateLimit(options.candidateLimit, limit);
    const lexicalWeight = searchWeight(options.lexicalWeight, "lexicalWeight", 1);
    const vectorWeight = searchWeight(options.vectorWeight, "vectorWeight", 0);
    if (vectorWeight !== 0) throw new RangeError("PostgreSQL search supports lexical retrieval only; vectorWeight must be zero");
    if (lexicalWeight === 0) throw new RangeError("lexicalWeight must be greater than zero for PostgreSQL lexical retrieval");
    const minScore = searchWeight(options.minScore, "minScore", 0);
    const scope = searchScope(options, this.tenantId);
    const queryTokens = lexicalTokens(query);
    if (limit === 0 || query.trim().length === 0 || queryTokens.length === 0 || !scope.matches) return [];

    return this.scoped(async (client) => {
      const textVector = "to_tsvector('simple', content_json::text)";
      const textQuery = "plainto_tsquery('simple', $1)";
      const predicates = [`${textVector} @@ ${textQuery}`];
      const parameters: unknown[] = [query];
      if (scope.tenantId !== undefined) {
        parameters.push(scope.tenantId);
        predicates.unshift(`tenant_id = $${parameters.length}`);
      }
      // ponytail: rank only a bounded unordered candidate window; raise candidateLimit or add a relevance index when exact global ranking is required.
      parameters.push(candidateLimit);
      const candidateLimitParameter = parameters.length;
      parameters.push(limit);
      const result = await client.query<Readonly<Record<string, unknown>>>(`
        WITH candidates AS MATERIALIZED (
          SELECT tenant_id, memory_id,
                 envelope_json,
                 content_json
          FROM ${this.runtime.records}
          WHERE ${predicates.join(" AND ")}
          LIMIT $${candidateLimitParameter}
        )
        SELECT tenant_id, memory_id,
               envelope_json::text AS envelope_json,
               content_json::text AS content_json,
               ts_rank_cd(${textVector}, ${textQuery}, 32) AS rank
        FROM candidates
        ORDER BY rank DESC, memory_id ASC
        LIMIT $${parameters.length}
      `, parameters);
      const hits: PostgresRuntimeSearchHit<T>[] = [];
      for (const row of result.rows) {
        const rowTenant = rowText(row, "tenant_id");
        const memoryId = rowText(row, "memory_id");
        const record = cloneJson(runtimeRecord<T>(row));
        if (rowTenant !== record.envelope.tenantId || memoryId !== record.envelope.memoryId) {
          throw new Error(`PostgreSQL search row identity mismatch: ${memoryId}`);
        }
        this.assertTenant(rowTenant);
        const rank = rowNumber(row, "rank");
        if (rank <= 0) continue;
        const score = rank / (rank + 1);
        if (score < minScore) continue;
        const content = cloneJson(record.content);
        const text = typeof content === "string" ? content : JSON.stringify(content) ?? String(content);
        const metadata = { tenantId: rowTenant };
        const document = { id: memoryId, text, content, metadata };
        hits.push({
          ...document,
          document,
          score,
          lexicalScore: score,
          vectorScore: 0,
          record,
          explanation: {
            reasons: ["PostgreSQL full-text search supplied the lexical retrieval signal.", "Vector retrieval is disabled for this PostgreSQL index."],
            metadata: { filterApplied: scope.filterApplied, matched: true },
            lexical: { queryTokens, matchedTokens: queryTokens, bm25: rank, normalizedScore: score, tokenCoverage: 1 },
            vector: { provider: "postgresql-fts", mode: "external", used: false, cosineSimilarity: 0, normalizedScore: 0 },
            fusion: { lexicalWeight, vectorWeight: 0, finalScore: score, rank: hits.length + 1, tieBreak: "score desc, lexical desc, vector desc, id asc" }
          }
        });
      }
      return hits;
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

  async pruneHttpIdempotency(options: HttpIdempotencyPruneOptions = {}): Promise<number> {
    if (this.tenantId === undefined) throw new Error("HTTP idempotency pruning requires a tenant-scoped PostgreSQL store");
    const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1_000;
    const inProgressMaxAgeMs = options.inProgressMaxAgeMs ?? 2 * HTTP_IDEMPOTENCY_LEASE_MS;
    const limit = options.limit ?? 1_000;
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new TypeError("HTTP idempotency maxAgeMs must be a positive safe integer");
    if (!Number.isSafeInteger(inProgressMaxAgeMs) || inProgressMaxAgeMs < HTTP_IDEMPOTENCY_LEASE_MS) throw new TypeError("HTTP idempotency inProgressMaxAgeMs is too short");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError("HTTP idempotency prune limit must be between 1 and 10000");
    return this.httpTransaction(this.tenantId, async (client) => {
      const result = await client.query(`
        WITH expired AS (
          SELECT tenant_id, operation, idempotency_key
          FROM ${this.runtime.idempotency}
          WHERE tenant_id = $1
            AND ((state = 'COMPLETED' AND updated_at < CURRENT_TIMESTAMP - ($2::bigint * INTERVAL '1 millisecond'))
              OR (state = 'IN_PROGRESS' AND updated_at < CURRENT_TIMESTAMP - ($3::bigint * INTERVAL '1 millisecond')))
          ORDER BY updated_at
          FOR UPDATE SKIP LOCKED
          LIMIT $4
        )
        DELETE FROM ${this.runtime.idempotency} AS target
        USING expired
        WHERE target.tenant_id = expired.tenant_id
          AND target.operation = expired.operation
          AND target.idempotency_key = expired.idempotency_key
      `, [this.tenantId, maxAgeMs, inProgressMaxAgeMs, limit]);
      return result.rowCount ?? result.rows.length;
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

  /**
   * Loads the live runtime state without constructing or persisting a
   * monolithic RuntimeSnapshot. Keyset pagination keeps each page bounded;
   * REPEATABLE READ makes the record and event walk one consistent view.
   */
  async loadIncrementally(options: PostgresRuntimeLoadOptions<T>): Promise<PostgresRuntimeLoadResult> {
    if (options === null || typeof options !== "object") throw new TypeError("load options are required");
    if (typeof options.onRecord !== "function" || typeof options.onEvent !== "function") throw new TypeError("load options require onRecord and onEvent callbacks");
    const batchSize = loadBatchSize(options.batchSize);
    return this.transaction(async (client) => {
      let recordTenantCursor = "";
      let recordMemoryCursor = "";
      let records = 0;
      while (true) {
        const result = this.tenantId === undefined
          ? await client.query<Readonly<Record<string, unknown>>>(`
              SELECT tenant_id, envelope_json::text AS envelope_json, content_json::text AS content_json
              FROM ${this.runtime.records}
              WHERE (tenant_id, memory_id) > ($1, $2)
              ORDER BY tenant_id, memory_id
              LIMIT $3
            `, [recordTenantCursor, recordMemoryCursor, batchSize])
          : await client.query<Readonly<Record<string, unknown>>>(`
              SELECT tenant_id, envelope_json::text AS envelope_json, content_json::text AS content_json
              FROM ${this.runtime.records}
              WHERE tenant_id = $1 AND memory_id > $2
              ORDER BY memory_id
              LIMIT $3
            `, [this.tenantId, recordMemoryCursor, batchSize]);
        if (result.rows.length === 0) break;
        for (const row of result.rows) {
          const record = runtimeRecord<T>(row);
          const rowTenant = rowText(row, "tenant_id");
          if (rowTenant !== record.envelope.tenantId) throw new Error(`PostgreSQL record tenant mismatch: ${record.envelope.memoryId}`);
          this.assertTenant(record.envelope.tenantId);
          await options.onRecord(record);
          recordTenantCursor = rowTenant;
          recordMemoryCursor = record.envelope.memoryId;
          records += 1;
        }
        if (result.rows.length < batchSize) break;
      }

      let eventCursor = 0;
      let events = 0;
      while (true) {
        const result = this.tenantId === undefined
          ? await client.query<Readonly<Record<string, unknown>>>(`
              SELECT sequence, tenant_id, event_json::text AS event_json
              FROM ${this.runtime.events}
              WHERE sequence > $1
              ORDER BY sequence
              LIMIT $2
            `, [eventCursor, batchSize])
          : await client.query<Readonly<Record<string, unknown>>>(`
              SELECT sequence, tenant_id, event_json::text AS event_json
              FROM ${this.runtime.events}
              WHERE tenant_id = $1 AND sequence > $2
              ORDER BY sequence
              LIMIT $3
            `, [this.tenantId, eventCursor, batchSize]);
        if (result.rows.length === 0) break;
        for (const row of result.rows) {
          const event = runtimeEvent(row);
          const rowTenant = rowText(row, "tenant_id");
          if (rowTenant !== event.tenantId) throw new Error(`PostgreSQL event tenant mismatch: ${event.eventId}`);
          this.assertTenant(event.tenantId);
          eventCursor = rowSequence(row, "sequence");
          await options.onEvent(event, eventCursor);
          events += 1;
        }
        if (result.rows.length < batchSize) break;
      }
      return { records, events };
    }, { isolation: "repeatable read", readOnly: true });
  }

  /**
   * Restores a streamed source in one transaction. The source is consumed
   * while the transaction is open, so a malformed or incomplete backup rolls
   * back the destructive clear instead of leaving a partial restore committed.
   */
  async restoreIncrementally(options: PostgresRuntimeRestoreOptions<T>): Promise<PostgresRuntimeRestoreSourceResult> {
    if (options === null || typeof options !== "object" || typeof options.source !== "function") throw new TypeError("restore options require a source callback");
    return this.transaction(async (client) => {
      await this.clearOn(client);
      let records = 0;
      let events = 0;
      const sourceResult = await options.source({
        onRecord: async (record) => {
          const checked = { envelope: parseMemoryEnvelopeV2(cloneJson(record?.envelope)), content: cloneJson(record?.content) };
          this.assertTenant(checked.envelope.tenantId);
          await this.putOn(client, checked, true);
          records += 1;
        },
        onEvent: async (event) => {
          const checked = parseV2Event(cloneJson(event));
          this.assertTenant(checked.tenantId);
          await this.appendEventOn(client, checked, true);
          events += 1;
        }
      });
      assertDateTime(sourceResult.capturedAt, "restore source capturedAt");
      if (sourceResult.records !== records || sourceResult.events !== events) throw new Error("PREMiSE incremental restore count verification failed");
      return sourceResult;
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
      await this.clearOn(client);
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

  private async appendEventOn(client: PostgresAdapter, parsed: V2Event, rejectExisting = false): Promise<void> {
    const serialized = json(parsed);
    const result = await client.query<Readonly<Record<string, unknown>>>(`
      INSERT INTO ${this.runtime.events}(tenant_id, idempotency_key, event_id, event_json, occurred_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING event_id, event_json::text AS event_json
    `, [parsed.tenantId, parsed.idempotencyKey, parsed.eventId, serialized, parsed.occurredAt]);
    if (result.rows.length > 0) return;
    if (rejectExisting) throw new Error(`Duplicate event in PREMiSE restore: ${parsed.idempotencyKey}`);
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

  private async clearOn(client: PostgresAdapter): Promise<void> {
    if (this.tenantId === undefined) {
      await client.query(`DELETE FROM ${this.runtime.events}`);
      await client.query(`DELETE FROM ${this.runtime.records}`);
      await client.query(`DELETE FROM ${this.runtime.snapshots}`);
      await client.query(`DELETE FROM ${this.runtime.checkpoints}`);
      return;
    }
    await client.query(`DELETE FROM ${this.runtime.events} WHERE tenant_id = $1`, [this.tenantId]);
    await client.query(`DELETE FROM ${this.runtime.records} WHERE tenant_id = $1`, [this.tenantId]);
    await client.query(`DELETE FROM ${this.runtime.snapshots} WHERE tenant_id = $1`, [this.snapshotTenant()]);
    await client.query(`DELETE FROM ${this.runtime.checkpoints} WHERE tenant_id = $1`, [this.tenantId]);
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

/**
 * Structural index adapter for PremiseServer. PostgreSQL is the source of
 * truth, so upsert only waits for the durable runtime write already queued by
 * DurableMirrorStore; it never creates a second in-memory index.
 */
export class PostgresLexicalIndex<T = unknown> {
  private readonly awaitDurability: (() => void | Promise<void>) | undefined;

  constructor(
    private readonly store: Pick<PostgresRuntimeStore<T>, "search">,
    options: PostgresLexicalIndexOptions = {}
  ) {
    this.awaitDurability = options.awaitDurability;
  }

  async upsert(_document: { readonly id: string; readonly text: string; readonly content?: T; readonly metadata?: Readonly<Record<string, unknown>> }): Promise<void> {
    await this.awaitDurability?.();
  }

  search(query: string, options: PostgresRuntimeSearchOptions = {}): Promise<readonly PostgresRuntimeSearchHit<T>[]> {
    return this.store.search(query, options);
  }
}

export function openPostgresRuntimeStore<T = unknown>(client: PostgresAdapter, options: PostgresRuntimeStoreOptions = {}): PostgresRuntimeStore<T> {
  return new PostgresRuntimeStore<T>(client, options);
}

export * from "./persistent.js";
