import { DatabaseSync } from "node:sqlite";
import { parseMemoryEnvelope, type MemoryEnvelope, type PremiseEvent, type PremiseEventType } from "@premise/protocol-types";

export const SIDECAR_SCHEMA_VERSION = 1 as const;

const eventTypes = new Set<PremiseEventType>([
  "MemoryRegistered",
  "MemoryDerived",
  "SourceChanged",
  "MemoryStaled",
  "MemoryInvalidated",
  "MemoryRevalidated",
  "MemoryReplaced"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isVersion(value: unknown): boolean {
  return isRecord(value)
    && typeof value.scheme === "string"
    && value.scheme.length > 0
    && typeof value.token === "string"
    && value.token.length > 0;
}

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value must be JSON serializable");
  return JSON.parse(serialized) as T;
}

function assertEvent(input: unknown): PremiseEvent {
  if (!isRecord(input)) throw new TypeError("PREMiSE event must be an object");
  const allowed = new Set(["specVersion", "eventId", "type", "occurredAt", "memoryId", "payload"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new TypeError(`Event field is not permitted: ${key}`);
  if (input.specVersion !== "premise/0.1") throw new TypeError("Event specVersion must be premise/0.1");
  if (typeof input.eventId !== "string" || input.eventId.length === 0) throw new TypeError("Event eventId must be non-empty");
  if (typeof input.type !== "string" || !eventTypes.has(input.type as PremiseEventType)) throw new TypeError("Event type is invalid");
  if (!isDateTime(input.occurredAt)) throw new TypeError("Event occurredAt must be a date-time");
  if (input.type !== "SourceChanged" && (typeof input.memoryId !== "string" || input.memoryId.length === 0)) {
    throw new TypeError("This event type requires memoryId");
  }
  if (!isRecord(input.payload)) throw new TypeError("Event payload must be an object");

  switch (input.type) {
    case "MemoryRegistered":
      {
        const envelope = parseMemoryEnvelope(input.payload.envelope);
        if (envelope.memoryId !== input.memoryId) throw new TypeError("MemoryRegistered event and envelope IDs must match");
      }
      break;
    case "MemoryDerived":
      if (!Array.isArray(input.payload.dependsOn) || input.payload.dependsOn.length === 0 || input.payload.dependsOn.some((id) => typeof id !== "string" || id.length === 0) || new Set(input.payload.dependsOn).size !== input.payload.dependsOn.length) {
        throw new TypeError("MemoryDerived payload requires dependencies");
      }
      break;
    case "SourceChanged":
      if (typeof input.payload.sourceUri !== "string" || input.payload.sourceUri.length === 0 || !isVersion(input.payload.version)) {
        throw new TypeError("SourceChanged payload requires sourceUri and version");
      }
      break;
    case "MemoryStaled":
    case "MemoryInvalidated":
      if (typeof input.payload.reason !== "string" || input.payload.reason.length === 0) throw new TypeError(`${input.type} requires a reason`);
      break;
    case "MemoryRevalidated":
      if (input.payload.result !== "UNCHANGED" && input.payload.result !== "CHANGED" && input.payload.result !== "MISSING" && input.payload.result !== "UNKNOWN") {
        throw new TypeError("MemoryRevalidated result is invalid");
      }
      if ((input.payload.result === "UNCHANGED" || input.payload.result === "CHANGED") && !isVersion(input.payload.version)) {
        throw new TypeError("This validation result requires a version");
      }
      const expectedStatus = input.payload.result === "UNCHANGED" ? "FRESH" : input.payload.result === "CHANGED" || input.payload.result === "MISSING" ? "INVALID" : "UNKNOWN";
      if (input.payload.status !== expectedStatus) throw new TypeError(`MemoryRevalidated status must be ${expectedStatus}`);
      break;
    case "MemoryReplaced":
      if (typeof input.payload.replacementMemoryId !== "string" || input.payload.replacementMemoryId.length === 0) {
        throw new TypeError("MemoryReplaced requires replacementMemoryId");
      }
      break;
  }
  return input as unknown as PremiseEvent;
}

function textColumn(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`SQLite row is missing text column ${column}`);
  return value;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS premise_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS premise_memories (
      memory_id TEXT PRIMARY KEY,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      spec_version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS premise_dependencies (
      memory_id TEXT NOT NULL,
      dependency_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (memory_id, dependency_id),
      UNIQUE (memory_id, position),
      FOREIGN KEY (memory_id) REFERENCES premise_memories(memory_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS premise_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      memory_id TEXT,
      occurred_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS premise_events_memory_idx ON premise_events(memory_id, sequence);
  `);
  const versions = database.prepare("SELECT version FROM premise_schema_migrations ORDER BY version ASC").all().map((row) => Number(row.version));
  if (versions.some((version) => !Number.isInteger(version) || version > SIDECAR_SCHEMA_VERSION)) throw new Error("SQLite sidecar schema is newer than this implementation");
  if (!versions.includes(SIDECAR_SCHEMA_VERSION)) database.prepare("INSERT INTO premise_schema_migrations(version) VALUES (?)").run(SIDECAR_SCHEMA_VERSION);
}

export class SqlitePremiseIndex {
  readonly filename: string;
  private database: DatabaseSync | undefined;

  constructor(filename: string) {
    if (typeof filename !== "string" || filename.length === 0) throw new TypeError("SQLite filename must be non-empty");
    this.filename = filename;
    this.reopen();
  }

  get isOpen(): boolean {
    return this.database !== undefined;
  }

  reopen(): void {
    this.close();
    const database = new DatabaseSync(this.filename);
    try {
      migrate(database);
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

  upsertEnvelope(input: MemoryEnvelope): void {
    const envelope = parseMemoryEnvelope(input);
    const database = this.requireDatabase();
    this.transaction(() => {
      database.prepare(`
        INSERT INTO premise_memories(memory_id, envelope_json, status, checked_at, spec_version)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          envelope_json = excluded.envelope_json,
          status = excluded.status,
          checked_at = excluded.checked_at,
          spec_version = excluded.spec_version
      `).run(
        envelope.memoryId,
        JSON.stringify(cloneJson(envelope)),
        envelope.validity.status,
        envelope.validity.checkedAt,
        envelope.specVersion
      );
      database.prepare("DELETE FROM premise_dependencies WHERE memory_id = ?").run(envelope.memoryId);
      const insertDependency = database.prepare("INSERT INTO premise_dependencies(memory_id, dependency_id, position) VALUES (?, ?, ?)");
      envelope.dependsOn.forEach((dependencyId, position) => insertDependency.run(envelope.memoryId, dependencyId, position));
    });
  }

  getEnvelope(memoryId: string): MemoryEnvelope | undefined {
    const row = this.requireDatabase().prepare("SELECT envelope_json FROM premise_memories WHERE memory_id = ?").get(memoryId);
    if (row === undefined) return undefined;
    return parseMemoryEnvelope(JSON.parse(textColumn(row, "envelope_json")));
  }

  listDependencies(memoryId: string): readonly string[] {
    const rows = this.requireDatabase().prepare("SELECT dependency_id FROM premise_dependencies WHERE memory_id = ? ORDER BY position ASC").all(memoryId);
    return rows.map((row) => textColumn(row, "dependency_id"));
  }

  appendEvent(input: PremiseEvent): PremiseEvent {
    const event = assertEvent(cloneJson(input));
    const database = this.requireDatabase();
    if (database.prepare("SELECT 1 AS present FROM premise_events WHERE event_id = ?").get(event.eventId) !== undefined) {
      throw new Error(`Duplicate eventId: ${event.eventId}`);
    }
    database.prepare(`
      INSERT INTO premise_events(event_id, memory_id, occurred_at, event_type, event_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.eventId, event.memoryId ?? null, event.occurredAt, event.type, JSON.stringify(event));
    return cloneJson(event);
  }

  listEvents(memoryId?: string): readonly PremiseEvent[] {
    const rows = memoryId === undefined
      ? this.requireDatabase().prepare("SELECT event_json FROM premise_events ORDER BY sequence ASC").all()
      : this.requireDatabase().prepare("SELECT event_json FROM premise_events WHERE memory_id = ? ORDER BY sequence ASC").all(memoryId);
    return rows.map((row) => assertEvent(JSON.parse(textColumn(row, "event_json"))));
  }

  history(memoryId: string): readonly PremiseEvent[] {
    return this.listEvents(memoryId);
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === undefined) throw new Error("SqlitePremiseIndex is closed");
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

export { SqlitePremiseIndex as SqliteSidecar };

export function openSqliteSidecar(filename: string): SqlitePremiseIndex {
  return new SqlitePremiseIndex(filename);
}
