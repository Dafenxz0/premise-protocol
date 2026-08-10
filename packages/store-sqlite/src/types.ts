import type { MemoryEnvelope, PremiseEvent } from "@premise/protocol-types";

export type StoreResult<T> = T | Promise<T>;

export interface StoreSnapshot<T = unknown> {
  readonly memoryId: string;
  readonly sequence: number;
  readonly state: T;
  readonly updatedAt?: string;
}

export interface IdempotencyRecord<T = unknown> {
  readonly key: string;
  readonly response: T;
  readonly requestHash?: string;
  readonly createdAt?: string;
}

export interface PersistentStore {
  saveEnvelope(envelope: MemoryEnvelope): StoreResult<void>;
  getEnvelope(memoryId: string): StoreResult<MemoryEnvelope | undefined>;
  listEnvelopes(): StoreResult<readonly MemoryEnvelope[]>;
  appendEvent(event: PremiseEvent): StoreResult<PremiseEvent>;
  listEvents(memoryId?: string): StoreResult<readonly PremiseEvent[]>;
  history(memoryId: string): StoreResult<readonly PremiseEvent[]>;
  saveSnapshot<T = unknown>(snapshot: StoreSnapshot<T>): StoreResult<StoreSnapshot<T>>;
  getSnapshot<T = unknown>(memoryId: string): StoreResult<StoreSnapshot<T> | undefined>;
  saveIdempotency<T = unknown>(record: IdempotencyRecord<T>): StoreResult<IdempotencyRecord<T>>;
  getIdempotency<T = unknown>(key: string): StoreResult<IdempotencyRecord<T> | undefined>;
  close(): StoreResult<void>;
}

export type Snapshot<T = unknown> = StoreSnapshot<T>;
export type IdempotencyEntry<T = unknown> = IdempotencyRecord<T>;

export interface NormalizedSnapshot<T = unknown> extends StoreSnapshot<T> {
  readonly updatedAt: string;
}

export interface NormalizedIdempotencyRecord<T = unknown> extends IdempotencyRecord<T> {
  readonly createdAt: string;
}

export function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Store values must be JSON serializable");
  return JSON.parse(serialized) as T;
}

function assertKey(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be non-empty`);
}

function assertDateTime(value: string, label: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date-time`);
  }
}

export function normalizeSnapshot<T>(input: StoreSnapshot<T>): NormalizedSnapshot<T> {
  if (input === null || typeof input !== "object") throw new TypeError("Snapshot must be an object");
  assertKey(input.memoryId, "Snapshot memoryId");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new TypeError("Snapshot sequence must be a non-negative safe integer");
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  assertDateTime(updatedAt, "Snapshot updatedAt");
  return { memoryId: input.memoryId, sequence: input.sequence, state: cloneJson(input.state), updatedAt };
}

export function normalizeIdempotency<T>(input: IdempotencyRecord<T>): NormalizedIdempotencyRecord<T> {
  if (input === null || typeof input !== "object") throw new TypeError("Idempotency record must be an object");
  assertKey(input.key, "Idempotency key");
  if (input.requestHash !== undefined) assertKey(input.requestHash, "Idempotency requestHash");
  const createdAt = input.createdAt ?? new Date().toISOString();
  assertDateTime(createdAt, "Idempotency createdAt");
  return { key: input.key, response: cloneJson(input.response), ...(input.requestHash === undefined ? {} : { requestHash: input.requestHash }), createdAt };
}

export function assertLookupKey(value: string, label: string): void {
  assertKey(value, label);
}
