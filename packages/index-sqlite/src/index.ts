import { DatabaseSync } from "node:sqlite";
import type { MemoryEnvelope, PremiseEvent } from "@premise/protocol-types";

export class SqlitePremiseIndex {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS premise_memories (
        memory_id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS premise_dependencies (
        memory_id TEXT NOT NULL,
        dependency_id TEXT NOT NULL,
        PRIMARY KEY (memory_id, dependency_id),
        FOREIGN KEY (memory_id) REFERENCES premise_memories(memory_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS premise_events (
        event_id TEXT PRIMARY KEY,
        memory_id TEXT,
        occurred_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS premise_events_memory_idx ON premise_events(memory_id, occurred_at, event_id);
    `);
  }

  upsertEnvelope(envelope: MemoryEnvelope): void {
    this.database.prepare(`INSERT INTO premise_memories(memory_id, envelope_json, status, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET envelope_json=excluded.envelope_json, status=excluded.status, checked_at=excluded.checked_at`).run(
      envelope.memoryId,
      JSON.stringify(envelope),
      envelope.validity.status,
      envelope.validity.checkedAt
    );
    this.database.prepare("DELETE FROM premise_dependencies WHERE memory_id = ?").run(envelope.memoryId);
    const dependency = this.database.prepare("INSERT INTO premise_dependencies(memory_id, dependency_id) VALUES (?, ?)");
    for (const dependencyId of envelope.dependsOn) dependency.run(envelope.memoryId, dependencyId);
  }

  getEnvelope(memoryId: string): MemoryEnvelope | undefined {
    const row = this.database.prepare("SELECT envelope_json FROM premise_memories WHERE memory_id = ?").get(memoryId);
    return row ? JSON.parse(String(row.envelope_json)) as MemoryEnvelope : undefined;
  }

  listDependencies(memoryId: string): readonly string[] {
    return this.database.prepare("SELECT dependency_id FROM premise_dependencies WHERE memory_id = ? ORDER BY dependency_id").all(memoryId).map((row) => String(row.dependency_id));
  }

  appendEvent(event: PremiseEvent): void {
    this.database.prepare("INSERT INTO premise_events(event_id, memory_id, occurred_at, event_type, event_json) VALUES (?, ?, ?, ?, ?)").run(event.eventId, event.memoryId ?? null, event.occurredAt, event.type, JSON.stringify(event));
  }

  listEvents(memoryId?: string): readonly PremiseEvent[] {
    const rows = memoryId === undefined
      ? this.database.prepare("SELECT event_json FROM premise_events ORDER BY occurred_at, event_id").all()
      : this.database.prepare("SELECT event_json FROM premise_events WHERE memory_id = ? ORDER BY occurred_at, event_id").all(memoryId);
    return rows.map((row) => JSON.parse(String(row.event_json)) as PremiseEvent);
  }

  close(): void {
    this.database.close();
  }
}
