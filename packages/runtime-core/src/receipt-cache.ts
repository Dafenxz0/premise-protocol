import { createHash } from "node:crypto";
import {
  premiseReceiptSharingKey,
  type PremiseReceiptSharingScope
} from "./premise-policy.js";

export type RuntimeReceiptState = "FRESH";

export interface RuntimeReceipt<T = unknown> {
  readonly scope: PremiseReceiptSharingScope;
  readonly state: RuntimeReceiptState;
  readonly valid: true;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly value: T;
  readonly semanticFingerprint?: string;
}

export interface RuntimeReceiptLookup<T = unknown> {
  readonly status: "HIT" | "MISS" | "REJECT";
  readonly reason?: "NOT_FOUND" | "EXPIRED" | "INVALID_SCOPE";
  readonly receipt?: RuntimeReceipt<T>;
}

export interface RuntimeReceiptCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly staleRejections: number;
  readonly evictions: number;
  readonly entries: number;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("receipt values must be JSON serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  throw new TypeError("receipt values must be JSON serializable");
}

function clone<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("receipt values must be JSON serializable");
  return JSON.parse(serialized) as T;
}

function cloneScope(scope: PremiseReceiptSharingScope): PremiseReceiptSharingScope {
  return Object.freeze({
    ...scope,
    scopes: Object.freeze([...scope.scopes]),
    causalFrontier: Object.freeze([...scope.causalFrontier])
  });
}

function assertTimestamp(value: string, name: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO timestamp`);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function sameOrBefore(now: string, expiry: string): boolean {
  return Date.parse(now) < Date.parse(expiry);
}

/**
 * Opt-in exact receipt cache. It is intentionally not wired into the default
 * runtime path: callers must explicitly provide the complete sharing scope.
 */
export class RuntimeReceiptCache<T = unknown> {
  private readonly entries = new Map<string, RuntimeReceipt<T>>();
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;
  private staleRejections = 0;
  private evictions = 0;

  constructor(options: { maxEntries?: number } = {}) {
    const maxEntries = options.maxEntries ?? 1024;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
    this.maxEntries = maxEntries;
  }

  put(receipt: RuntimeReceipt<T>): string {
    if (receipt.state !== "FRESH" || receipt.valid !== true) throw new TypeError("only valid FRESH receipts may enter the cache");
    assertTimestamp(receipt.observedAt, "receipt.observedAt");
    assertTimestamp(receipt.expiresAt, "receipt.expiresAt");
    if (!sameOrBefore(receipt.observedAt, receipt.expiresAt)) throw new RangeError("receipt expiry must be after observation");
    const key = premiseReceiptSharingKey(receipt.scope);
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, Object.freeze({ ...receipt, scope: cloneScope(receipt.scope), value: clone(receipt.value) }));
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
    return key;
  }

  get(scope: PremiseReceiptSharingScope, now: string): RuntimeReceiptLookup<T> {
    assertTimestamp(now, "now");
    let key: string;
    try {
      key = premiseReceiptSharingKey(scope);
    } catch {
      return Object.freeze({ status: "REJECT", reason: "INVALID_SCOPE" });
    }
    const receipt = this.entries.get(key);
    if (receipt === undefined) {
      this.misses += 1;
      return Object.freeze({ status: "MISS", reason: "NOT_FOUND" });
    }
    if (!sameOrBefore(now, receipt.expiresAt)) {
      this.entries.delete(key);
      this.staleRejections += 1;
      return Object.freeze({ status: "REJECT", reason: "EXPIRED" });
    }
    this.hits += 1;
    return Object.freeze({ status: "HIT", receipt: clone(receipt) });
  }

  invalidate(scope: PremiseReceiptSharingScope): boolean {
    let key: string;
    try { key = premiseReceiptSharingKey(scope); } catch { return false; }
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): RuntimeReceiptCacheStats {
    return Object.freeze({ hits: this.hits, misses: this.misses, staleRejections: this.staleRejections, evictions: this.evictions, entries: this.entries.size });
  }
}

/** Negative facts are never returned as fresh evidence and expire separately. */
export class RuntimeNegativeCache {
  private readonly entries = new Map<string, { tenantId: string; reason: string; expiresAt: string }>();
  private readonly tenantCounts = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly maxEntriesPerTenant: number | undefined;
  private hits = 0;
  private misses = 0;
  private expirations = 0;
  private evictions = 0;
  private peakEntries = 0;

  constructor(options: { maxEntries?: number; maxEntriesPerTenant?: number } = {}) {
    const maxEntries = options.maxEntries ?? 1024;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
    if (options.maxEntriesPerTenant !== undefined
      && (!Number.isSafeInteger(options.maxEntriesPerTenant) || options.maxEntriesPerTenant < 1)) {
      throw new RangeError("maxEntriesPerTenant must be a positive integer");
    }
    this.maxEntries = maxEntries;
    this.maxEntriesPerTenant = options.maxEntriesPerTenant;
  }

  private delete(key: string, reason: "expiration" | "eviction" | "replace"): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.entries.delete(key);
    const tenantCount = this.tenantCounts.get(entry.tenantId) ?? 0;
    if (tenantCount <= 1) this.tenantCounts.delete(entry.tenantId);
    else this.tenantCounts.set(entry.tenantId, tenantCount - 1);
    if (reason === "expiration") this.expirations += 1;
    if (reason === "eviction") this.evictions += 1;
    return true;
  }

  private evictOldest(predicate?: (entry: { tenantId: string; reason: string; expiresAt: string }) => boolean): void {
    for (const [key, entry] of this.entries) {
      if (predicate === undefined || predicate(entry)) {
        this.delete(key, "eviction");
        return;
      }
    }
  }

  private enforceBounds(tenantId: string): void {
    while (this.entries.size > this.maxEntries) this.evictOldest();
    if (this.maxEntriesPerTenant === undefined) return;
    while ((this.tenantCounts.get(tenantId) ?? 0) > this.maxEntriesPerTenant) {
      this.evictOldest((entry) => entry.tenantId === tenantId);
    }
  }

  put(scope: PremiseReceiptSharingScope, reason: string, expiresAt: string): string {
    if (typeof reason !== "string" || reason.length === 0) throw new TypeError("negative-cache reason must be non-empty");
    assertTimestamp(expiresAt, "expiresAt");
    const key = premiseReceiptSharingKey(scope);
    this.delete(key, "replace");
    this.entries.set(key, { tenantId: scope.tenantId, reason, expiresAt });
    this.tenantCounts.set(scope.tenantId, (this.tenantCounts.get(scope.tenantId) ?? 0) + 1);
    this.peakEntries = Math.max(this.peakEntries, this.entries.size);
    this.enforceBounds(scope.tenantId);
    return key;
  }

  get(scope: PremiseReceiptSharingScope, now: string): { status: "NEGATIVE" | "MISS"; reason?: string } {
    assertTimestamp(now, "now");
    const key = premiseReceiptSharingKey(scope);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return { status: "MISS" };
    }
    if (!sameOrBefore(now, entry.expiresAt)) {
      this.delete(key, "expiration");
      this.misses += 1;
      return { status: "MISS" };
    }
    this.hits += 1;
    return Object.freeze({ status: "NEGATIVE", reason: entry.reason });
  }

  clear(): void {
    this.entries.clear();
    this.tenantCounts.clear();
  }

  stats(): Readonly<{
    hits: number;
    misses: number;
    expirations: number;
    evictions: number;
    entries: number;
    peakEntries: number;
  }> {
    return Object.freeze({
      hits: this.hits,
      misses: this.misses,
      expirations: this.expirations,
      evictions: this.evictions,
      entries: this.entries.size,
      peakEntries: this.peakEntries
    });
  }
}

export function semanticFingerprint(input: { resourceId: string; incarnationId: string; aspect: string; digest: string }): string {
  for (const [name, value] of Object.entries(input)) if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be non-empty`);
  return digest({ domain: "premise-semantic-fingerprint/1", ...input });
}

export type EventContinuityResult =
  | { readonly status: "FRESH"; readonly finalSequence: number; readonly applied: readonly number[] }
  | { readonly status: "UNKNOWN"; readonly reason: "EMPTY" | "GAP" | "INVALID_SEQUENCE"; readonly applied: readonly number[] };

export function assessEventContinuity(events: readonly { sequence: number }[]): EventContinuityResult {
  if (events.length === 0) return Object.freeze({ status: "UNKNOWN", reason: "EMPTY", applied: Object.freeze([]) });
  const sequences = [...new Set(events.map(({ sequence }) => sequence))].sort((left, right) => left - right);
  if (sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0)) return Object.freeze({ status: "UNKNOWN", reason: "INVALID_SEQUENCE", applied: Object.freeze(sequences) });
  for (let index = 1; index < sequences.length; index += 1) {
    if (sequences[index] !== sequences[index - 1]! + 1) return Object.freeze({ status: "UNKNOWN", reason: "GAP", applied: Object.freeze(sequences) });
  }
  return Object.freeze({ status: "FRESH", finalSequence: sequences.at(-1)!, applied: Object.freeze(sequences) });
}

export type OrderedEventKind = "SNAPSHOT" | "DELTA";

export interface OrderedEventObservation {
  readonly streamId: string;
  readonly sequence: number;
  readonly kind: OrderedEventKind;
  readonly eventId?: string;
  readonly cursor?: string;
}

export type OrderedEventContinuityResult =
  | {
      readonly status: "FRESH";
      readonly finalSequence: number;
      readonly applied: readonly number[];
      readonly duplicates: readonly number[];
    }
  | {
      readonly status: "UNKNOWN";
      readonly reason: "EMPTY" | "INVALID_EVENT" | "INVALID_SEQUENCE" | "STREAM_MISMATCH" | "GAP" | "REORDERED" | "CONFLICT" | "DELTA_BEFORE_SNAPSHOT";
      readonly applied: readonly number[];
      readonly duplicates: readonly number[];
    };

/**
 * Checks an ordered delivery stream without sorting away delivery hazards.
 * Duplicate deliveries of the exact same event are harmless; a reordered,
 * gapped or conflicting sequence fails closed. A consumer that starts from a
 * trusted snapshot may set `requireSnapshot` to require the first unique
 * observation to establish that snapshot before applying deltas.
 */
export function assessOrderedEventContinuity(
  events: readonly OrderedEventObservation[],
  options: { readonly expectedSequence?: number; readonly requireSnapshot?: boolean } = {}
): OrderedEventContinuityResult {
  if (!Array.isArray(events)) return Object.freeze({ status: "UNKNOWN", reason: "INVALID_EVENT", applied: Object.freeze([]), duplicates: Object.freeze([]) });
  if (events.length === 0) return Object.freeze({ status: "UNKNOWN", reason: "EMPTY", applied: Object.freeze([]), duplicates: Object.freeze([]) });
  const first = events[0]!;
  const expectedSequence = options?.expectedSequence;
  const requireSnapshot = options?.requireSnapshot === true;
  if (expectedSequence !== undefined && (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0)) {
    return Object.freeze({ status: "UNKNOWN", reason: "INVALID_SEQUENCE", applied: Object.freeze([]), duplicates: Object.freeze([]) });
  }
  const applied: number[] = [];
  const duplicates: number[] = [];
  const fingerprints = new Map<number, string>();
  let lastSequence: number | undefined;
  let hasSnapshot = false;
  for (const event of events) {
    if (event === null || typeof event !== "object" || typeof event.streamId !== "string" || event.streamId.length === 0
      || (event.kind !== "SNAPSHOT" && event.kind !== "DELTA")
      || (event.eventId !== undefined && typeof event.eventId !== "string")
      || (event.cursor !== undefined && typeof event.cursor !== "string")) {
      return Object.freeze({ status: "UNKNOWN", reason: "INVALID_EVENT", applied: Object.freeze(applied), duplicates: Object.freeze(duplicates) });
    }
    if (event.streamId !== first.streamId) {
      return Object.freeze({ status: "UNKNOWN", reason: "STREAM_MISMATCH", applied: Object.freeze(applied), duplicates: Object.freeze(duplicates) });
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      return Object.freeze({ status: "UNKNOWN", reason: "INVALID_SEQUENCE", applied: Object.freeze(applied), duplicates: Object.freeze(duplicates) });
    }
    const fingerprint = JSON.stringify([event.kind, event.eventId ?? null, event.cursor ?? null]);
    const prior = fingerprints.get(event.sequence);
    if (lastSequence !== undefined && event.sequence < lastSequence) {
      return Object.freeze({ status: "UNKNOWN", reason: "REORDERED", applied: Object.freeze(applied), duplicates: Object.freeze(duplicates) });
    }
    if (lastSequence !== undefined && event.sequence > lastSequence + 1) {
      return Object.freeze({ status: "UNKNOWN", reason: "GAP", applied: Object.freeze(applied), duplicates: Object.freeze(duplicates) });
    }
    if (prior !== undefined) {
      if (prior !== fingerprint) return Object.freeze({ status: "UNKNOWN", reason: "CONFLICT", applied: Object.freeze(applied), duplicates: Object.freeze(duplicates) });
      duplicates.push(event.sequence);
      continue;
    }
    if (lastSequence === undefined && expectedSequence !== undefined && event.sequence !== expectedSequence) {
      return Object.freeze({ status: "UNKNOWN", reason: "GAP", applied: Object.freeze(applied), duplicates: Object.freeze(duplicates) });
    }
    if (requireSnapshot && !hasSnapshot && event.kind !== "SNAPSHOT") {
      return Object.freeze({ status: "UNKNOWN", reason: "DELTA_BEFORE_SNAPSHOT", applied: Object.freeze(applied), duplicates: Object.freeze(duplicates) });
    }
    fingerprints.set(event.sequence, fingerprint);
    applied.push(event.sequence);
    lastSequence = event.sequence;
    hasSnapshot ||= event.kind === "SNAPSHOT";
  }
  return Object.freeze({ status: "FRESH", finalSequence: lastSequence!, applied: Object.freeze(applied), duplicates: Object.freeze(duplicates) });
}
