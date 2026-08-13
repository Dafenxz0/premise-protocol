import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseV2Event, type V2Event } from "@premise/protocol-types";
import type { RuntimeDecisionEvent } from "./instrumentation.js";

export interface RuntimeJournalEventEntry {
  readonly kind: "event";
  readonly cursor: number;
  readonly tenantId: string;
  readonly event: V2Event;
}

export interface RuntimeJournalDecisionEntry {
  readonly kind: "decision";
  readonly cursor: number;
  readonly tenantId: string;
  readonly occurredAt: string;
  readonly decision: RuntimeDecisionEvent;
}

export type RuntimeJournalEntry = RuntimeJournalEventEntry | RuntimeJournalDecisionEntry;

export interface RuntimeJournalCheckpoint {
  readonly checkpointId: string;
  readonly cursor: number;
  readonly digest: `sha256:${string}`;
  readonly state: unknown;
}

export interface RuntimeJournalReadOptions {
  readonly tenantId?: string;
  readonly limit?: number;
}

/**
 * Audit history is deliberately separate from the bounded operational state.
 * Cursors are exclusive: readFrom(10) returns entries after cursor 10.
 */
export interface RuntimeJournal {
  appendEvent(event: V2Event): number;
  appendDecision(tenantId: string, decision: RuntimeDecisionEvent, occurredAt: string): number;
  readFrom(cursor: number, options?: RuntimeJournalReadOptions): readonly RuntimeJournalEntry[];
  latestCursor(): number;
  checkpoint(value: RuntimeJournalCheckpoint): void;
  latestCheckpoint(): RuntimeJournalCheckpoint | undefined;
}

function clone<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("journal values must be JSON serializable");
  return JSON.parse(serialized) as T;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("journal values must be JSON serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  throw new TypeError("journal values must be JSON serializable");
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new TypeError(`${name} must be a non-empty string`);
}

function assertCursor(value: number, name = "cursor"): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

function assertLimit(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError("journal limit must be a positive safe integer");
}

function assertTimestamp(value: string, name: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO timestamp`);
}

function assertDecision(decision: RuntimeDecisionEvent): RuntimeDecisionEvent {
  if (decision === null || typeof decision !== "object") throw new TypeError("journal decision must be an object");
  assertNonEmpty(decision.memoryId, "decision.memoryId");
  assertNonEmpty(decision.decision, "decision.decision");
  if (decision.reason !== undefined) assertNonEmpty(decision.reason, "decision.reason");
  return Object.freeze({ ...decision });
}

function digestState(state: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(state), "utf8").digest("hex")}`;
}

function checkedCheckpoint(value: RuntimeJournalCheckpoint): RuntimeJournalCheckpoint {
  if (value === null || typeof value !== "object") throw new TypeError("journal checkpoint must be an object");
  assertNonEmpty(value.checkpointId, "checkpoint.checkpointId");
  assertCursor(value.cursor, "checkpoint.cursor");
  if (typeof value.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.digest)) throw new TypeError("checkpoint.digest must be a sha256 digest");
  const state = clone(value.state);
  if (digestState(state) !== value.digest) throw new Error("journal checkpoint digest does not match state");
  return Object.freeze({ checkpointId: value.checkpointId, cursor: value.cursor, digest: value.digest, state });
}

function checkedEntry(value: unknown): RuntimeJournalEntry {
  if (value === null || typeof value !== "object") throw new TypeError("journal entry must be an object");
  const candidate = value as Partial<RuntimeJournalEntry>;
  assertCursor(candidate.cursor as number);
  const tenantId = candidate.tenantId as string;
  assertNonEmpty(tenantId, "entry.tenantId");
  if (candidate.kind === "event") {
    const event = parseV2Event(clone(candidate.event));
    if (event.tenantId !== tenantId) throw new Error("journal event tenant does not match entry tenant");
    return Object.freeze({ kind: "event", cursor: candidate.cursor as number, tenantId, event });
  }
  if (candidate.kind === "decision") {
    assertTimestamp(candidate.occurredAt as string, "entry.occurredAt");
    return Object.freeze({
      kind: "decision",
      cursor: candidate.cursor as number,
      tenantId,
      occurredAt: candidate.occurredAt as string,
      decision: assertDecision(candidate.decision as RuntimeDecisionEvent)
    });
  }
  throw new TypeError("journal entry kind must be event or decision");
}

function readOptions(options: RuntimeJournalReadOptions | undefined): RuntimeJournalReadOptions {
  if (options === undefined) return {};
  if (options.tenantId !== undefined) assertNonEmpty(options.tenantId, "tenantId");
  assertLimit(options.limit);
  return options;
}

abstract class BaseJournal implements RuntimeJournal {
  protected readonly entries: RuntimeJournalEntry[] = [];
  protected readonly eventCursors = new Map<string, number>();
  protected nextCursorValue = 1;
  protected lastCheckpoint: RuntimeJournalCheckpoint | undefined;

  appendEvent(event: V2Event): number {
    const parsed = parseV2Event(clone(event));
    const key = `${parsed.tenantId}\u0000${parsed.idempotencyKey}`;
    const previousCursor = this.eventCursors.get(key);
    if (previousCursor !== undefined) {
      const previous = this.entries.find((entry) => entry.cursor === previousCursor);
      if (previous?.kind !== "event" || previous.event.requestDigest !== parsed.requestDigest || previous.event.eventId !== parsed.eventId) {
        throw new Error(`Conflicting journal event: ${parsed.idempotencyKey}`);
      }
      return previousCursor;
    }
    const entry = checkedEntry({ kind: "event", cursor: this.nextCursorValue, tenantId: parsed.tenantId, event: parsed });
    this.nextCursorValue += 1;
    this.entries.push(entry);
    this.eventCursors.set(key, entry.cursor);
    this.persistEntry(entry);
    return entry.cursor;
  }

  appendDecision(tenantId: string, decision: RuntimeDecisionEvent, occurredAt: string): number {
    assertNonEmpty(tenantId, "tenantId");
    assertTimestamp(occurredAt, "occurredAt");
    const entry = checkedEntry({ kind: "decision", cursor: this.nextCursorValue, tenantId, occurredAt, decision });
    this.nextCursorValue += 1;
    this.entries.push(entry);
    this.persistEntry(entry);
    return entry.cursor;
  }

  readFrom(cursor: number, options?: RuntimeJournalReadOptions): readonly RuntimeJournalEntry[] {
    assertCursor(cursor);
    const checked = readOptions(options);
    const filtered = this.entries.filter((entry) => entry.cursor > cursor && (checked.tenantId === undefined || entry.tenantId === checked.tenantId));
    return Object.freeze(filtered.slice(0, checked.limit).map((entry) => clone(entry)));
  }

  latestCursor(): number {
    return this.nextCursorValue - 1;
  }

  checkpoint(value: RuntimeJournalCheckpoint): void {
    const checked = checkedCheckpoint(value);
    if (checked.cursor > this.latestCursor()) throw new RangeError("checkpoint cursor is ahead of the journal");
    if (this.lastCheckpoint !== undefined && checked.cursor < this.lastCheckpoint.cursor) throw new RangeError("checkpoint cursor cannot move backwards");
    this.lastCheckpoint = checked;
    this.persistCheckpoint(checked);
  }

  latestCheckpoint(): RuntimeJournalCheckpoint | undefined {
    return this.lastCheckpoint === undefined ? undefined : clone(this.lastCheckpoint);
  }

  protected abstract persistEntry(entry: RuntimeJournalEntry): void;
  protected abstract persistCheckpoint(checkpoint: RuntimeJournalCheckpoint): void;
}

export class InMemoryJournal extends BaseJournal {
  protected persistEntry(_entry: RuntimeJournalEntry): void { /* already resident */ }
  protected persistCheckpoint(_checkpoint: RuntimeJournalCheckpoint): void { /* already resident */ }
}

/**
 * Append-only JSONL journal for local recovery. A torn final line is ignored
 * and truncated on load; any malformed non-final line fails closed.
 */
export class FileJournal extends BaseJournal {
  readonly path: string;
  private readonly checkpointPath: string;

  constructor(path: string) {
    super();
    assertNonEmpty(path, "path");
    this.path = path;
    this.checkpointPath = `${path}.checkpoint.json`;
    mkdirSync(dirname(path), { recursive: true });
    this.load();
  }

  protected persistEntry(entry: RuntimeJournalEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  protected persistCheckpoint(checkpoint: RuntimeJournalCheckpoint): void {
    const temporary = join(dirname(this.checkpointPath), `.${this.checkpointPath.split(/[\\/]/u).at(-1)!}.tmp-${process.pid}-${Date.now()}`);
    writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, "utf8");
    try {
      renameSync(temporary, this.checkpointPath);
    } catch (error) {
      try { unlinkSync(this.checkpointPath); } catch { /* target may not exist */ }
      renameSync(temporary, this.checkpointPath);
      void error;
    }
  }

  private load(): void {
    if (existsSync(this.path)) {
      const source = readFileSync(this.path, "utf8");
      const lines = source.split("\n");
      let validBytes = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const isFinalPartial = index === lines.length - 1 && line.length > 0;
        if (line.length === 0) {
          validBytes += Buffer.byteLength(index === lines.length - 1 ? "" : "\n", "utf8");
          continue;
        }
        try {
          const entry = checkedEntry(JSON.parse(line));
          if (entry.cursor !== this.nextCursorValue) throw new Error("journal cursors must be contiguous");
          this.entries.push(entry);
          if (entry.kind === "event") this.eventCursors.set(`${entry.tenantId}\u0000${entry.event.idempotencyKey}`, entry.cursor);
          this.nextCursorValue += 1;
          validBytes += Buffer.byteLength(line, "utf8") + (isFinalPartial ? 0 : Buffer.byteLength("\n", "utf8"));
        } catch (error) {
          if (!isFinalPartial) throw error;
          writeFileSync(this.path, Buffer.from(source, "utf8").subarray(0, validBytes));
          break;
        }
      }
    } else writeFileSync(this.path, "", "utf8");
    if (existsSync(this.checkpointPath)) {
      const source = readFileSync(this.checkpointPath, "utf8").trim();
      if (source.length > 0) this.lastCheckpoint = checkedCheckpoint(JSON.parse(source));
    }
    if (this.lastCheckpoint !== undefined && this.lastCheckpoint.cursor > this.latestCursor()) throw new Error("journal checkpoint is ahead of journal history");
  }
}

export function journalCheckpointDigest(state: unknown): `sha256:${string}` {
  return digestState(state);
}
