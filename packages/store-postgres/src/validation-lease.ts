import type {
  ValidationLease,
  ValidationLeaseAcquireRequest,
  ValidationLeaseReleaseRequest,
  ValidationLeaseRenewRequest,
  ValidationLeaseStoreAcquireResult,
  ValidationLeaseStoreMutationResult,
  ValidationLeaseStoreRejectionReason,
  ValidationLeaseStoreValidationResult,
  ValidationLeaseValidateRequest
} from "@premise/runtime-core";
import { identifier, setTenantContext, withPostgresTransaction, type PostgresAdapter } from "./driver.js";

type LeaseRow = Readonly<Record<string, unknown>>;

export interface PostgresValidationLeaseStoreOptions {
  /** Lowercase SQL identifier. The table is tenant-scoped with forced RLS. */
  readonly tableName?: string;
}

const DEFAULT_TABLE_NAME = "premise_validation_leases";

function text(value: unknown, column: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`PostgreSQL lease row has invalid ${column}`);
  }
  return value;
}

function integer(value: unknown, column: string): number {
  const parsed = typeof value === "bigint" ? Number(value)
    : typeof value === "number" ? value
      : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`PostgreSQL lease row has invalid ${column}`);
  return parsed;
}

function positiveInteger(value: unknown, column: string): number {
  const parsed = integer(value, column);
  if (parsed === 0) throw new Error(`PostgreSQL lease row has invalid ${column}`);
  return parsed;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validToken(value: unknown): value is number {
  return validTime(value) && value > 0;
}

function leaseFromRow(row: LeaseRow): ValidationLease {
  return Object.freeze({
    tenantId: text(row.tenant_id, "tenant_id"),
    resourceId: text(row.resource_id, "resource_id"),
    owner: text(row.owner, "owner"),
    leaseId: text(row.lease_id, "lease_id"),
    fencingToken: positiveInteger(row.fencing_token, "fencing_token"),
    acquiredAt: integer(row.acquired_at, "acquired_at"),
    renewedAt: integer(row.renewed_at, "renewed_at"),
    expiresAt: integer(row.expires_at, "expires_at")
  });
}

function validateNow(now: number): void {
  if (!validTime(now)) throw new TypeError("now must be a non-negative safe integer");
}

function validateScope(tenantId: string, resourceId: string): void {
  if (!validText(tenantId)) throw new TypeError("tenantId must be a non-empty string without surrounding whitespace");
  if (!validText(resourceId)) throw new TypeError("resourceId must be a non-empty string without surrounding whitespace");
}

function validateAcquire(request: ValidationLeaseAcquireRequest, now: number): void {
  validateScope(request.tenantId, request.resourceId);
  if (!validText(request.owner)) throw new TypeError("owner must be a non-empty string without surrounding whitespace");
  if (!validText(request.leaseId)) throw new TypeError("leaseId must be a non-empty string without surrounding whitespace");
  if (!validTime(request.expiresAt) || request.expiresAt <= now) throw new TypeError("expiresAt must be after now");
}

function validateRenew(request: ValidationLeaseRenewRequest, now: number): void {
  validateScope(request.tenantId, request.resourceId);
  if (!validText(request.owner)) throw new TypeError("owner must be a non-empty string without surrounding whitespace");
  if (!validText(request.leaseId)) throw new TypeError("leaseId must be a non-empty string without surrounding whitespace");
  if (!validToken(request.fencingToken)) throw new TypeError("fencingToken must be a positive safe integer");
  if (!validTime(request.expiresAt) || request.expiresAt <= now) throw new TypeError("expiresAt must be after now");
}

function validateMutation(request: ValidationLeaseReleaseRequest | ValidationLeaseValidateRequest): void {
  validateScope(request.tenantId, request.resourceId);
  if (!validText(request.owner)) throw new TypeError("owner must be a non-empty string without surrounding whitespace");
  if (!validText(request.leaseId)) throw new TypeError("leaseId must be a non-empty string without surrounding whitespace");
  if (!validToken(request.fencingToken)) throw new TypeError("fencingToken must be a positive safe integer");
}

function identityReason(current: ValidationLease, request: ValidationLeaseReleaseRequest | ValidationLeaseRenewRequest | ValidationLeaseValidateRequest): ValidationLeaseStoreRejectionReason | undefined {
  if (current.owner !== request.owner) return "OWNER_MISMATCH";
  if (current.leaseId !== request.leaseId) return "LEASE_ID_MISMATCH";
  if (current.fencingToken !== request.fencingToken) return "STALE_FENCING_TOKEN";
  return undefined;
}

/**
 * PostgreSQL-backed lease store for the asynchronous adapter boundary.
 *
 * Each operation is one transaction and uses the tenant context plus explicit
 * tenant predicates. The runtime-core lease contract remains synchronous for
 * compatibility; this adapter returns the same result shapes asynchronously.
 */
export class PostgresValidationLeaseStore {
  private readonly table: string;
  private readonly tableName: string;

  constructor(private readonly adapter: PostgresAdapter, options: PostgresValidationLeaseStoreOptions = {}) {
    if (adapter === undefined || typeof adapter.query !== "function") throw new TypeError("PostgresAdapter.query is required");
    if (typeof adapter.transaction !== "function") throw new TypeError("PostgresValidationLeaseStore requires a pinned transaction adapter");
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.table = identifier(this.tableName);
  }

  async initialize(): Promise<void> {
    const policy = identifier(`${this.tableName}_tenant_isolation`);
    await withPostgresTransaction(this.adapter, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          tenant_id TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          owner TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
          acquired_at BIGINT NOT NULL CHECK (acquired_at >= 0),
          renewed_at BIGINT NOT NULL CHECK (renewed_at >= acquired_at),
          expires_at BIGINT NOT NULL CHECK (expires_at > renewed_at),
          PRIMARY KEY (tenant_id, resource_id)
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

  async acquire(request: ValidationLeaseAcquireRequest, now: number): Promise<ValidationLeaseStoreAcquireResult> {
    validateNow(now);
    validateAcquire(request, now);
    return this.inTenant(request.tenantId, async (client) => {
      const result = await client.query<LeaseRow>(`
        INSERT INTO ${this.table} (tenant_id, resource_id, owner, lease_id, fencing_token, acquired_at, renewed_at, expires_at)
        VALUES ($1, $2, $3, $4, 1, $5, $5, $6)
        ON CONFLICT (tenant_id, resource_id) DO UPDATE SET
          owner = EXCLUDED.owner,
          lease_id = EXCLUDED.lease_id,
          fencing_token = ${this.table}.fencing_token + 1,
          acquired_at = EXCLUDED.acquired_at,
          renewed_at = EXCLUDED.renewed_at,
          expires_at = EXCLUDED.expires_at
        WHERE ${this.table}.expires_at <= $5
        RETURNING tenant_id, resource_id, owner, lease_id, fencing_token, acquired_at, renewed_at, expires_at
      `, [request.tenantId, request.resourceId, request.owner, request.leaseId, now, request.expiresAt]);
      const row = result.rows[0];
      if (row !== undefined) return { kind: "ACQUIRED", lease: leaseFromRow(row) };
      const current = await this.current(client, request.tenantId, request.resourceId);
      if (current === undefined) throw new Error("PostgreSQL lease row disappeared after atomic acquire");
      if (current.expiresAt <= now) throw new Error("PostgreSQL lease acquire observed an expired row after atomic conflict");
      return { kind: "HELD", lease: current };
    });
  }

  async renew(request: ValidationLeaseRenewRequest, now: number): Promise<ValidationLeaseStoreMutationResult> {
    validateNow(now);
    validateRenew(request, now);
    return this.inTenant(request.tenantId, async (client) => {
      const result = await client.query<LeaseRow>(`
        UPDATE ${this.table}
        SET renewed_at = $6, expires_at = $7
        WHERE tenant_id = $1 AND resource_id = $2 AND owner = $3 AND lease_id = $4
          AND fencing_token = $5 AND expires_at > $6
        RETURNING tenant_id, resource_id, owner, lease_id, fencing_token, acquired_at, renewed_at, expires_at
      `, [request.tenantId, request.resourceId, request.owner, request.leaseId, request.fencingToken, now, request.expiresAt]);
      const row = result.rows[0];
      if (row !== undefined) return { kind: "UPDATED", lease: leaseFromRow(row) };
      return { kind: "REJECTED", reason: await this.rejectionFor(client, request, now) };
    });
  }

  async release(request: ValidationLeaseReleaseRequest, now: number): Promise<ValidationLeaseStoreMutationResult> {
    validateNow(now);
    validateMutation(request);
    return this.inTenant(request.tenantId, async (client) => {
      const result = await client.query(`
        UPDATE ${this.table}
        SET expires_at = $6
        WHERE tenant_id = $1 AND resource_id = $2 AND owner = $3 AND lease_id = $4
          AND fencing_token = $5 AND expires_at > $6
      `, [request.tenantId, request.resourceId, request.owner, request.leaseId, request.fencingToken, now]);
      if ((result.rowCount ?? 0) > 0) return { kind: "RELEASED" };
      return { kind: "REJECTED", reason: await this.rejectionFor(client, request, now) };
    });
  }

  async validate(request: ValidationLeaseValidateRequest, now: number): Promise<ValidationLeaseStoreValidationResult> {
    validateNow(now);
    validateMutation(request);
    return this.inTenant(request.tenantId, async (client) => {
      const current = await this.current(client, request.tenantId, request.resourceId);
      if (current === undefined) return { kind: "REJECTED", reason: "LEASE_MISSING" };
      if (current.expiresAt <= now) return { kind: "REJECTED", reason: "LEASE_EXPIRED" };
      const failure = identityReason(current, request);
      if (failure !== undefined) return { kind: "REJECTED", reason: failure };
      return { kind: "VALID", lease: current };
    });
  }

  async close(): Promise<void> {
    await this.adapter.close?.();
  }

  private async rejectionFor(
    client: PostgresAdapter,
    request: ValidationLeaseReleaseRequest | ValidationLeaseRenewRequest,
    now: number
  ): Promise<ValidationLeaseStoreRejectionReason> {
    const current = await this.current(client, request.tenantId, request.resourceId);
    if (current === undefined) return "LEASE_MISSING";
    if (current.expiresAt <= now) return "LEASE_EXPIRED";
    const failure = identityReason(current, request);
    if (failure !== undefined) return failure;
    throw new Error("PostgreSQL lease mutation lost its compare-and-set race");
  }

  private async current(client: PostgresAdapter, tenantId: string, resourceId: string): Promise<ValidationLease | undefined> {
    const result = await client.query<LeaseRow>(`
      SELECT tenant_id, resource_id, owner, lease_id, fencing_token, acquired_at, renewed_at, expires_at
      FROM ${this.table}
      WHERE tenant_id = $1 AND resource_id = $2
    `, [tenantId, resourceId]);
    const row = result.rows[0];
    return row === undefined ? undefined : leaseFromRow(row);
  }

  private inTenant<T>(tenantId: string, action: (client: PostgresAdapter) => Promise<T>): Promise<T> {
    return withPostgresTransaction(this.adapter, async (client) => {
      await setTenantContext(client, tenantId);
      return action(client);
    });
  }
}
