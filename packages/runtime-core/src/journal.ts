import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
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

export type RuntimeJournalPageOptions = RuntimeJournalReadOptions & { readonly limit: number };

export interface RuntimeJournalPage {
  readonly entries: readonly RuntimeJournalEntry[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

/** Additive paged-read capability; the original RuntimeJournal contract is unchanged. */
export interface RuntimeJournalPageReader {
  readPage(cursor: number, options: RuntimeJournalPageOptions): RuntimeJournalPage;
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

interface JournalEventIndex {
  readonly cursor: number;
  readonly eventId: string;
  readonly requestDigest: string;
}

interface JournalLine {
  readonly line: string;
  readonly terminated: boolean;
  readonly end: number;
}

const JOURNAL_READ_CHUNK_SIZE = 64 * 1024;

interface SyncFileSystem {
  openSync(path: string, flags: string): number;
  readSync(descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  closeSync(descriptor: number): void;
  ftruncateSync(descriptor: number, length: number): void;
}

const syncFileSystem = nodeFs as unknown as SyncFileSystem;

function decodeSegments(segments: readonly Uint8Array[], bytes: number): string {
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const segment of segments) {
    combined.set(segment, offset);
    offset += segment.length;
  }
  return new TextDecoder().decode(combined);
}

function* journalLines(path: string): Generator<JournalLine> {
  const descriptor = syncFileSystem.openSync(path, "r");
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let fileOffset = 0;
  try {
    const chunk = new Uint8Array(JOURNAL_READ_CHUNK_SIZE);
    for (;;) {
      const bytesRead = syncFileSystem.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const segment = chunk.subarray(segmentStart, index);
        if (segment.length > 0) {
          pending.push(new Uint8Array(segment));
          pendingBytes += segment.length;
        }
        const end = fileOffset + index + 1;
        yield {
          line: pendingBytes === 0 ? "" : decodeSegments(pending, pendingBytes),
          terminated: true,
          end
        };
        pending = [];
        pendingBytes = 0;
        segmentStart = index + 1;
      }
      if (segmentStart < bytesRead) {
        const segment = chunk.subarray(segmentStart, bytesRead);
        pending.push(new Uint8Array(segment));
        pendingBytes += segment.length;
      }
      fileOffset += bytesRead;
    }
    if (pendingBytes > 0) {
      yield {
        line: decodeSegments(pending, pendingBytes),
        terminated: false,
        end: fileOffset
      };
    }
  } finally {
    syncFileSystem.closeSync(descriptor);
  }
}

function truncateJournal(path: string, bytes: number): void {
  const descriptor = syncFileSystem.openSync(path, "r+");
  try {
    syncFileSystem.ftruncateSync(descriptor, bytes);
  } finally {
    syncFileSystem.closeSync(descriptor);
  }
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

abstract class BaseJournal implements RuntimeJournal, RuntimeJournalPageReader {
  protected readonly entries: RuntimeJournalEntry[] = [];
  protected readonly eventCursors = new Map<string, JournalEventIndex>();
  protected nextCursorValue = 1;
  protected lastCheckpoint: RuntimeJournalCheckpoint | undefined;

  appendEvent(event: V2Event): number {
    const parsed = parseV2Event(clone(event));
    const key = `${parsed.tenantId}\u0000${parsed.idempotencyKey}`;
    const previousCursor = this.eventCursors.get(key);
    if (previousCursor !== undefined) {
      if (previousCursor.requestDigest !== parsed.requestDigest || previousCursor.eventId !== parsed.eventId) {
        throw new Error(`Conflicting journal event: ${parsed.idempotencyKey}`);
      }
      return previousCursor.cursor;
    }
    const entry = checkedEntry({ kind: "event", cursor: this.nextCursorValue, tenantId: parsed.tenantId, event: parsed });
    this.nextCursorValue += 1;
    this.retainEntry(entry);
    this.eventCursors.set(key, { cursor: entry.cursor, eventId: parsed.eventId, requestDigest: parsed.requestDigest });
    this.persistEntry(entry);
    return entry.cursor;
  }

  appendDecision(tenantId: string, decision: RuntimeDecisionEvent, occurredAt: string): number {
    assertNonEmpty(tenantId, "tenantId");
    assertTimestamp(occurredAt, "occurredAt");
    const entry = checkedEntry({ kind: "decision", cursor: this.nextCursorValue, tenantId, occurredAt, decision });
    this.nextCursorValue += 1;
    this.retainEntry(entry);
    this.persistEntry(entry);
    return entry.cursor;
  }

  readFrom(cursor: number, options?: RuntimeJournalReadOptions): readonly RuntimeJournalEntry[] {
    assertCursor(cursor);
    const checked = readOptions(options);
    return Object.freeze(this.readEntries(cursor, checked, checked.limit).map((entry) => clone(entry)));
  }

  readPage(cursor: number, options: RuntimeJournalPageOptions): RuntimeJournalPage {
    assertCursor(cursor);
    if (options === undefined || options.limit === undefined) throw new TypeError("journal page limit is required");
    const checked = readOptions(options);
    const limit = options.limit;
    const scanLimit = limit === Number.MAX_SAFE_INTEGER ? limit : limit + 1;
    const selected = this.readEntries(cursor, checked, scanLimit);
    const hasMore = selected.length > limit;
    const entries = hasMore ? selected.slice(0, limit) : selected;
    return Object.freeze({
      entries: Object.freeze(entries.map((entry) => clone(entry))),
      nextCursor: entries.at(-1)?.cursor ?? cursor,
      hasMore
    });
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

  protected retainEntry(entry: RuntimeJournalEntry): void {
    this.entries.push(entry);
  }

  protected readEntries(cursor: number, options: RuntimeJournalReadOptions, maxEntries?: number): RuntimeJournalEntry[] {
    const filtered = this.entries.filter((entry) => entry.cursor > cursor && (options.tenantId === undefined || entry.tenantId === options.tenantId));
    return maxEntries === undefined ? filtered : filtered.slice(0, maxEntries);
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

  protected override retainEntry(_entry: RuntimeJournalEntry): void {
    // FileJournal reads pages from disk; it does not retain the complete history.
  }

  protected override readEntries(cursor: number, options: RuntimeJournalReadOptions, maxEntries?: number): RuntimeJournalEntry[] {
    const entries: RuntimeJournalEntry[] = [];
    for (const item of journalLines(this.path)) {
      if (item.line.length === 0) continue;
      const entry = checkedEntry(JSON.parse(item.line));
      if (entry.cursor <= cursor || (options.tenantId !== undefined && entry.tenantId !== options.tenantId)) continue;
      entries.push(entry);
      if (maxEntries !== undefined && entries.length >= maxEntries) break;
    }
    return entries;
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
      let validBytes = 0;
      let needsTrailingNewline = false;
      let truncateBytes: number | undefined;
      for (const item of journalLines(this.path)) {
        const { line } = item;
        if (line.length === 0) {
          validBytes = item.end;
          continue;
        }
        try {
          const entry = checkedEntry(JSON.parse(line));
          if (entry.cursor !== this.nextCursorValue) throw new Error("journal cursors must be contiguous");
          if (entry.kind === "event") {
            this.eventCursors.set(`${entry.tenantId}\u0000${entry.event.idempotencyKey}`, {
              cursor: entry.cursor,
              eventId: entry.event.eventId,
              requestDigest: entry.event.requestDigest
            });
          }
          this.nextCursorValue += 1;
          validBytes = item.end;
          needsTrailingNewline = !item.terminated;
        } catch (error) {
          if (item.terminated) throw error;
          truncateBytes = validBytes;
          break;
        }
      }
      if (truncateBytes !== undefined) truncateJournal(this.path, truncateBytes);
      else if (needsTrailingNewline) appendFileSync(this.path, "\n", "utf8");
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
