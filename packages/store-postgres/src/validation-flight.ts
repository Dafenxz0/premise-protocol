import { createHash } from "node:crypto";
import type { PostgresAdapter } from "./driver.js";
import { identifier, json, jsonValue, setTenantContext, withPostgresTransaction } from "./driver.js";

export interface ValidationFlightScope {
  readonly tenantId: string;
  readonly resourceId: string;
  readonly versionScheme: string;
  readonly versionToken: string;
  readonly authorizationContextDigest: string;
  readonly policyDigest: string;
  readonly queryDigest: string;
  readonly frontierDigest: string;
}

export type ValidationFlightClaim<T = unknown> =
  | Readonly<{ readonly kind: "LEADER"; readonly fencingToken: number; readonly expiresAt: number }>
  | Readonly<{ readonly kind: "FOLLOWER"; readonly fencingToken: number; readonly expiresAt: number }>
  | Readonly<{ readonly kind: "COMPLETED"; readonly fencingToken: number; readonly receipt: T }>
  | Readonly<{ readonly kind: "REJECTED"; readonly reason: "INVALID" | "STORE_UNAVAILABLE" }>;

export type ValidationFlightCompletion =
  | Readonly<{ readonly kind: "COMPLETED" }>
  | Readonly<{ readonly kind: "REJECTED"; readonly reason: "MISSING" | "EXPIRED" | "FENCED" | "INVALID" | "STORE_UNAVAILABLE" }>;

export type ValidationFlightRead<T = unknown> =
  | Readonly<{ readonly kind: "MISSING" }>
  | Readonly<{ readonly kind: "IN_PROGRESS"; readonly fencingToken: number; readonly expiresAt: number }>
  | Readonly<{ readonly kind: "COMPLETED"; readonly fencingToken: number; readonly receipt: T }>
  | Readonly<{ readonly kind: "EXPIRED"; readonly fencingToken: number }>;

export type ValidationFlightWait<T = unknown> =
  | Readonly<{ readonly kind: "COMPLETED"; readonly fencingToken: number; readonly receipt: T }>
  | Readonly<{ readonly kind: "EXPIRED" | "MISSING" | "TIMEOUT" }>;

export interface PostgresValidationFlightOptions {
  readonly tableName?: string;
  readonly defaultLeaseMs?: number;
  readonly completedRetentionMs?: number;
}

export interface ValidationFlightWaitOptions {
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly signal?: ValidationFlightAbortSignal;
}

export interface ValidationFlightAbortSignal {
  readonly aborted: boolean;
  addEventListener?(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

type FlightRow = Readonly<Record<string, unknown>>;

const DEFAULT_TABLE_NAME = "premise_validation_flights";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETENTION_MS = 60_000;
const SCOPE_FIELDS = [
  "tenantId",
  "resourceId",
  "versionScheme",
  "versionToken",
  "authorizationContextDigest",
  "policyDigest",
  "queryDigest",
  "frontierDigest"
] as const;

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function integerRow(value: unknown, name: string): number {
  const parsed = typeof value === "bigint" ? Number(value)
    : typeof value === "number" ? value
      : typeof value === "string" ? Number(value) : Number.NaN;
  return positiveInteger(parsed, name);
}

function validateScope(scope: ValidationFlightScope): void {
  for (const field of SCOPE_FIELDS) required(scope?.[field], field);
}

function scopePayload(scope: ValidationFlightScope): Record<string, string> {
  validateScope(scope);
  return Object.fromEntries(SCOPE_FIELDS.map((field) => [field, scope[field]]));
}

export function validationFlightScopeDigest(scope: ValidationFlightScope): string {
  const payload = scopePayload(scope);
  return `sha256:${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`;
}

function rowText(row: FlightRow, field: string): string {
  return required(row[field], `PostgreSQL flight row ${field}`);
}

function rowState(row: FlightRow): "IN_PROGRESS" | "COMPLETED" {
  const state = rowText(row, "state");
  if (state !== "IN_PROGRESS" && state !== "COMPLETED") throw new Error("PostgreSQL flight row has invalid state");
  return state;
}

function rowReceipt<T>(row: FlightRow): T {
  if (row.receipt_json === null || row.receipt_json === undefined) throw new Error("PostgreSQL completed flight is missing its receipt");
  return jsonValue(row, "receipt_json") as T;
}

function assertExpiry(now: number, duration: number): number {
  if (now > Number.MAX_SAFE_INTEGER - duration) throw new RangeError("flight expiry exceeds safe integer range");
  return now + duration;
}

const hostTimers = globalThis as unknown as { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void };

/**
 * Durable leader/follower coordination for one complete validation scope.
 *
 * The database row is the fence: an expired leader is replaced with a higher
 * token, and completion compares owner, flight id, state and token in one
 * conditional UPDATE. It stores no source data beyond the caller-supplied
 * completion receipt.
 */
export class PostgresValidationFlightStore {
  private readonly table: string;
  private readonly tableName: string;
  private readonly defaultLeaseMs: number;
  private readonly completedRetentionMs: number;

  constructor(private readonly adapter: PostgresAdapter, options: PostgresValidationFlightOptions = {}) {
    if (adapter === undefined || typeof adapter.query !== "function") throw new TypeError("PostgresAdapter.query is required");
    if (typeof adapter.transaction !== "function") throw new TypeError("PostgresValidationFlightStore requires a pinned transaction adapter");
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.table = identifier(this.tableName);
    this.defaultLeaseMs = options.defaultLeaseMs ?? DEFAULT_LEASE_MS;
    this.completedRetentionMs = options.completedRetentionMs ?? DEFAULT_RETENTION_MS;
    positiveInteger(this.defaultLeaseMs, "defaultLeaseMs");
    positiveInteger(this.completedRetentionMs, "completedRetentionMs");
  }

  async initialize(): Promise<void> {
    const policy = identifier(`${this.tableName}_tenant_isolation`);
    await withPostgresTransaction(this.adapter, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          scope_digest TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          scope_json JSONB NOT NULL,
          owner TEXT NOT NULL,
          flight_id TEXT NOT NULL,
          fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
          state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
          receipt_json JSONB,
          updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
          expires_at BIGINT NOT NULL CHECK (expires_at > updated_at)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${identifier(`${this.tableName}_expires_at_idx`)} ON ${this.table}(expires_at)`);
      await client.query(`ALTER TABLE ${this.table} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${this.table} FORCE ROW LEVEL SECURITY`);
      await client.query(`DROP POLICY IF EXISTS ${policy} ON ${this.table}`);
      await client.query(`
        CREATE POLICY ${policy} ON ${this.table}
        USING (tenant_id = current_setting('premise.tenant_id', true))
        WITH CHECK (tenant_id = current_setting('premise.tenant_id', true))
      `);
    });
  }

  async claim<T = unknown>(scope: ValidationFlightScope, owner: string, flightId: string, now: number, leaseMs = this.defaultLeaseMs): Promise<ValidationFlightClaim<T>> {
    try {
      validateScope(scope);
      required(owner, "owner");
      required(flightId, "flightId");
      nonNegativeInteger(now, "now");
      positiveInteger(leaseMs, "leaseMs");
      const expiresAt = assertExpiry(now, leaseMs);
      const digest = validationFlightScopeDigest(scope);
      const scopeJson = json(scopePayload(scope), "flight scope");
      return await this.inTenant(scope.tenantId, async (client) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const inserted = await client.query<FlightRow>(`
            INSERT INTO ${this.table} (scope_digest, tenant_id, scope_json, owner, flight_id, fencing_token, state, receipt_json, updated_at, expires_at)
            VALUES ($1, $2, $3::jsonb, $4, $5, 1, 'IN_PROGRESS', NULL, $6, $7)
            ON CONFLICT (scope_digest) DO UPDATE SET
              tenant_id = EXCLUDED.tenant_id,
              scope_json = EXCLUDED.scope_json,
              owner = EXCLUDED.owner,
              flight_id = EXCLUDED.flight_id,
              fencing_token = ${this.table}.fencing_token + 1,
              state = 'IN_PROGRESS',
              receipt_json = NULL,
              updated_at = EXCLUDED.updated_at,
              expires_at = EXCLUDED.expires_at
            WHERE ${this.table}.expires_at <= $6
            RETURNING fencing_token, state, expires_at, receipt_json
          `, [digest, scope.tenantId, scopeJson, owner, flightId, now, expiresAt]);
          const insertedRow = inserted.rows[0];
          if (insertedRow !== undefined) return { kind: "LEADER", fencingToken: integerRow(insertedRow.fencing_token, "fencing_token"), expiresAt: integerRow(insertedRow.expires_at, "expires_at") };

          const current = await this.current(client, scope, digest);
          if (current === undefined) continue;
          if (current.state === "COMPLETED" && current.expiresAt > now) return { kind: "COMPLETED", fencingToken: current.fencingToken, receipt: current.receipt as T };
          if (current.state === "IN_PROGRESS" && current.expiresAt > now) return { kind: "FOLLOWER", fencingToken: current.fencingToken, expiresAt: current.expiresAt };
        }
        throw new Error("PostgreSQL flight claim lost its compare-and-set race");
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) return { kind: "REJECTED", reason: "INVALID" };
      return { kind: "REJECTED", reason: "STORE_UNAVAILABLE" };
    }
  }

  async complete<T = unknown>(scope: ValidationFlightScope, owner: string, flightId: string, fencingToken: number, receipt: T, now: number, retentionMs = this.completedRetentionMs): Promise<ValidationFlightCompletion> {
    try {
      validateScope(scope);
      required(owner, "owner");
      required(flightId, "flightId");
      positiveInteger(fencingToken, "fencingToken");
      nonNegativeInteger(now, "now");
      positiveInteger(retentionMs, "retentionMs");
      const expiresAt = assertExpiry(now, retentionMs);
      const digest = validationFlightScopeDigest(scope);
      const receiptJson = json(receipt, "flight receipt");
      return await this.inTenant(scope.tenantId, async (client) => {
        const result = await client.query(`
          UPDATE ${this.table}
          SET state = 'COMPLETED', receipt_json = $6::jsonb, updated_at = $7, expires_at = $8
          WHERE scope_digest = $1 AND tenant_id = $2 AND owner = $3 AND flight_id = $4
            AND fencing_token = $5 AND state = 'IN_PROGRESS' AND expires_at > $7
        `, [digest, scope.tenantId, owner, flightId, fencingToken, receiptJson, now, expiresAt]);
        if ((result.rowCount ?? 0) > 0) return { kind: "COMPLETED" };
        const current = await this.current(client, scope, digest);
        if (current === undefined) return { kind: "REJECTED", reason: "MISSING" };
        if (current.expiresAt <= now) return { kind: "REJECTED", reason: "EXPIRED" };
        return { kind: "REJECTED", reason: "FENCED" };
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return { kind: "REJECTED", reason: "INVALID" };
      return { kind: "REJECTED", reason: "STORE_UNAVAILABLE" };
    }
  }

  async read<T = unknown>(scope: ValidationFlightScope, now: number): Promise<ValidationFlightRead<T>> {
    try {
      validateScope(scope);
      nonNegativeInteger(now, "now");
      const digest = validationFlightScopeDigest(scope);
      return await this.inTenant(scope.tenantId, async (client) => {
        const current = await this.current(client, scope, digest);
        if (current === undefined) return { kind: "MISSING" };
        if (current.expiresAt <= now) return { kind: "EXPIRED", fencingToken: current.fencingToken };
        if (current.state === "COMPLETED") return { kind: "COMPLETED", fencingToken: current.fencingToken, receipt: current.receipt as T };
        return { kind: "IN_PROGRESS", fencingToken: current.fencingToken, expiresAt: current.expiresAt };
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) return { kind: "MISSING" };
      throw error;
    }
  }

  async waitForCompletion<T = unknown>(scope: ValidationFlightScope, options: ValidationFlightWaitOptions = {}): Promise<ValidationFlightWait<T>> {
    const now = options.now ?? (() => Date.now());
    const timeoutMs = options.timeoutMs ?? this.defaultLeaseMs;
    const pollMs = options.pollMs ?? 25;
    nonNegativeInteger(timeoutMs, "timeoutMs");
    nonNegativeInteger(pollMs, "pollMs");
    const startedAt = now();
    const deadline = assertExpiry(startedAt, timeoutMs);
    while (true) {
      if (options.signal?.aborted === true) return { kind: "TIMEOUT" };
      const result = await this.read<T>(scope, now());
      if (result.kind === "COMPLETED") return result;
      if (result.kind === "MISSING" || result.kind === "EXPIRED") return result;
      if (now() >= deadline) return { kind: "TIMEOUT" };
      await new Promise<void>((resolve) => { hostTimers.setTimeout(resolve, pollMs); });
    }
  }

  async close(): Promise<void> {
    await this.adapter.close?.();
  }

  private async current(client: PostgresAdapter, scope: ValidationFlightScope, digest: string): Promise<Readonly<{ state: "IN_PROGRESS" | "COMPLETED"; fencingToken: number; expiresAt: number; receipt?: unknown }> | undefined> {
    const result = await client.query<FlightRow>(`
      SELECT scope_digest, tenant_id, scope_json::text AS scope_json, fencing_token, state, receipt_json::text AS receipt_json, expires_at
      FROM ${this.table}
      WHERE scope_digest = $1 AND tenant_id = $2
    `, [digest, scope.tenantId]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const storedScope = jsonValue(row, "scope_json");
    if (validationFlightScopeDigest(storedScope as ValidationFlightScope) !== digest) throw new Error("PostgreSQL flight scope digest mismatch");
    const state = rowState(row);
    return {
      state,
      fencingToken: integerRow(row.fencing_token, "fencing_token"),
      expiresAt: integerRow(row.expires_at, "expires_at"),
      ...(state === "COMPLETED" ? { receipt: rowReceipt(row) } : {})
    };
  }

  private inTenant<T>(tenantId: string, action: (client: PostgresAdapter) => Promise<T>): Promise<T> {
    return withPostgresTransaction(this.adapter, async (client) => {
      await setTenantContext(client, tenantId);
      return action(client);
    });
  }
}
