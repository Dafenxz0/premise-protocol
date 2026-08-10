export interface PostgresQueryResult<Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}
export type PostgresQuery = <Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(
  sql: string,
  parameters?: readonly unknown[]
) => Promise<PostgresQueryResult<Row>>;

export interface PostgresAdapter {
  readonly query: PostgresQuery;
  readonly transaction?: <T>(action: (client: PostgresAdapter) => Promise<T>) => Promise<T>;
  readonly close?: () => Promise<void> | void;
}

export type PostgresClient = PostgresAdapter;

export interface PostgresTransactionOptions {
  readonly isolation?: "read committed" | "repeatable read" | "serializable";
  readonly readOnly?: boolean;
}

export async function withPostgresTransaction<T>(
  adapter: PostgresAdapter,
  action: (client: PostgresAdapter) => Promise<T>,
  options: PostgresTransactionOptions = {}
): Promise<T> {
  if (adapter.transaction !== undefined) {
    return adapter.transaction(async (client) => {
      await setTransactionOptions(client, options);
      return action(client);
    });
  }

  const isolation = options.isolation === undefined ? "" : ` ISOLATION LEVEL ${options.isolation.toUpperCase()}`;
  const readOnly = options.readOnly === true ? " READ ONLY" : "";
  await adapter.query(`BEGIN${isolation}${readOnly}`);
  try {
    const result = await action(adapter);
    await adapter.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await adapter.query("ROLLBACK");
    } catch {
      // Preserve the operation error. The connection is discarded by callers on failure.
    }
    throw error;
  }
}

async function setTransactionOptions(adapter: PostgresAdapter, options: PostgresTransactionOptions): Promise<void> {
  if (options.isolation !== undefined) await adapter.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
  if (options.readOnly === true) await adapter.query("SET TRANSACTION READ ONLY");
}

export async function setTenantContext(adapter: PostgresAdapter, tenantId: string): Promise<void> {
  await adapter.query("SELECT set_config('premise.tenant_id', $1, true)", [tenantId]);
}

export function assertTenantId(value: string, label = "tenantId"): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new TypeError(`${label} must be a non-empty tenant id without surrounding whitespace`);
}

export function json<T>(value: T, label = "PostgreSQL value"): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${label} must be JSON serializable`);
  return serialized;
}

export function jsonValue(row: Readonly<Record<string, unknown>>, column: string): unknown {
  const value = row[column];
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`PostgreSQL row has invalid JSON column ${column}`, { cause: error });
  }
}

export function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new TypeError("PostgreSQL identifier must be a lowercase SQL identifier");
  return `"${value}"`;
}

export function rowText(row: Readonly<Record<string, unknown>>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`PostgreSQL row is missing text column ${column}`);
  return value;
}

export function rowSequence(row: Readonly<Record<string, unknown>>, column: string): number {
  const value = row[column];
  const sequence = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`PostgreSQL row has invalid integer column ${column}`);
  return sequence;
}
