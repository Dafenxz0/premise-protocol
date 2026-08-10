import { DatabaseSync } from "node:sqlite";
import { parseMemoryEnvelopeV2, parseV2Event, SPEC_VERSION_V2, type V2Event } from "@premise/protocol-types";
import type { RuntimeRecord, RuntimeSnapshot, RuntimeStore } from "@premise/runtime-core";

const SCHEMA_VERSION = 1;

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("SQLite runtime values must be JSON serializable");
  return JSON.parse(serialized) as T;
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`SQLite v2 row is missing ${column}`);
  return value;
}

export class SqliteRuntimeStore<T = unknown> implements RuntimeStore<T> {
  private database: DatabaseSync | undefined;

  constructor(readonly filename: string) {
    if (filename.length === 0) throw new TypeError("SQLite filename must be non-empty");
    this.open();
  }

  get isOpen(): boolean {
    return this.database !== undefined;
  }

  open(): void {
    this.close();
    const database = new DatabaseSync(this.filename);
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS premise_v2_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS premise_v2_records (
          memory_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          envelope_json TEXT NOT NULL,
          content_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS premise_v2_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          idempotency_key TEXT NOT NULL UNIQUE,
          event_id TEXT NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL,
          event_json TEXT NOT NULL
        );
      `);
      const version = database.prepare("SELECT value FROM premise_v2_meta WHERE key = 'schema_version'").get();
      if (version !== undefined && text(version, "value") !== String(SCHEMA_VERSION)) throw new Error("SQLite runtime schema version is newer than this implementation");
      if (version === undefined) database.prepare("INSERT INTO premise_v2_meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    if (this.database === undefined) return;
    this.database.close();
    this.database = undefined;
  }

  get(memoryId: string): RuntimeRecord<T> | undefined {
    const row = this.requireDatabase().prepare("SELECT envelope_json, content_json FROM premise_v2_records WHERE memory_id = ?").get(memoryId);
    if (row === undefined) return undefined;
    return { envelope: parseMemoryEnvelopeV2(JSON.parse(text(row, "envelope_json"))), content: JSON.parse(text(row, "content_json")) as T };
  }

  list(): readonly RuntimeRecord<T>[] {
    return this.requireDatabase().prepare("SELECT envelope_json, content_json FROM premise_v2_records ORDER BY memory_id ASC").all().map((row) => ({ envelope: parseMemoryEnvelopeV2(JSON.parse(text(row, "envelope_json"))), content: JSON.parse(text(row, "content_json")) as T }));
  }

  put(record: RuntimeRecord<T>): void {
    const envelope = parseMemoryEnvelopeV2(record.envelope);
    this.requireDatabase().prepare(`
      INSERT INTO premise_v2_records(memory_id, tenant_id, envelope_json, content_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET tenant_id = excluded.tenant_id, envelope_json = excluded.envelope_json, content_json = excluded.content_json
    `).run(envelope.memoryId, envelope.tenantId, JSON.stringify(cloneJson(envelope)), JSON.stringify(cloneJson(record.content)));
  }

  appendEvent(event: V2Event): void {
    const parsed = parseV2Event(event);
    const serialized = JSON.stringify(parsed);
    const database = this.requireDatabase();
    const existing = database.prepare("SELECT event_id, event_json FROM premise_v2_events WHERE idempotency_key = ?").get(parsed.idempotencyKey);
    if (existing !== undefined) {
      const existingEvent = parseV2Event(JSON.parse(text(existing, "event_json")));
      if (text(existing, "event_id") !== parsed.eventId || JSON.stringify(existingEvent) !== serialized) throw new Error(`Conflicting idempotency key: ${parsed.idempotencyKey}`);
      return;
    }
    database.prepare("INSERT INTO premise_v2_events(idempotency_key, event_id, tenant_id, event_json) VALUES (?, ?, ?, ?)").run(parsed.idempotencyKey, parsed.eventId, parsed.tenantId, serialized);
  }

  hasEvent(idempotencyKey: string): boolean {
    return this.requireDatabase().prepare("SELECT 1 AS present FROM premise_v2_events WHERE idempotency_key = ?").get(idempotencyKey) !== undefined;
  }

  listEvents(): readonly V2Event[] {
    return this.requireDatabase().prepare("SELECT event_json FROM premise_v2_events ORDER BY sequence ASC").all().map((row) => parseV2Event(JSON.parse(text(row, "event_json"))));
  }

  snapshot(capturedAt: string): RuntimeSnapshot<T> {
    return { format: "premise-runtime-snapshot", version: 1, capturedAt, records: this.list(), events: this.listEvents() };
  }

  restore(snapshot: RuntimeSnapshot<T>): void {
    if (snapshot.format !== "premise-runtime-snapshot" || snapshot.version !== 1) throw new Error("Unsupported PREMiSE runtime snapshot");
    this.transaction(() => {
      const database = this.requireDatabase();
      database.exec("DELETE FROM premise_v2_records; DELETE FROM premise_v2_events;");
      for (const record of snapshot.records) this.put(record);
      for (const event of snapshot.events) this.appendEvent(event);
    });
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === undefined) throw new Error("SqliteRuntimeStore is closed");
    return this.database;
  }

  private transaction(action: () => void): void {
    const database = this.requireDatabase();
    database.exec("BEGIN");
    try {
      action();
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    }
  }
}

export function openSqliteRuntimeStore<T = unknown>(filename: string): SqliteRuntimeStore<T> {
  return new SqliteRuntimeStore<T>(filename);
}

export const SQLITE_RUNTIME_SCHEMA_VERSION = SCHEMA_VERSION;
export const SQLITE_RUNTIME_SPEC_VERSION = SPEC_VERSION_V2;

export * from "./persistent.js";
