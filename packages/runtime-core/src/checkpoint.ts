import { createHash } from "node:crypto";
import type { RuntimeRecord } from "./index.js";

export const RUNTIME_CHECKPOINT_FORMAT = "premise-runtime-checkpoint" as const;
export const RUNTIME_CHECKPOINT_VERSION = 1 as const;

export interface RuntimeOperationalCheckpoint<T = unknown> {
  readonly format: typeof RUNTIME_CHECKPOINT_FORMAT;
  readonly version: typeof RUNTIME_CHECKPOINT_VERSION;
  readonly capturedAt: string;
  readonly activeRecords: readonly RuntimeRecord<T>[];
  readonly frontierState: unknown;
  readonly incarnations: unknown;
  readonly eventCursor: number;
  readonly receiptEpoch: number;
  readonly idempotencyState: unknown;
  readonly sourceVersions: unknown;
  readonly dependencyState: unknown;
  readonly digest: `sha256:${string}`;
}

export type RuntimeOperationalCheckpointInput<T = unknown> = Omit<RuntimeOperationalCheckpoint<T>, "digest">;

export interface RuntimeCheckpointTailEntry {
  readonly cursor: number;
  readonly event?: unknown;
}

export type RuntimeCheckpointRecovery =
  | { readonly status: "READY"; readonly checkpoint: RuntimeOperationalCheckpoint; readonly finalCursor: number }
  | { readonly status: "INVALID"; readonly reason: "CHECKPOINT" | "TAIL_GAP" | "TAIL_REORDERED" | "TAIL_CURSOR" };

function clone<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("checkpoint values must be JSON serializable");
  return JSON.parse(serialized) as T;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("checkpoint values must be JSON serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  throw new TypeError("checkpoint values must be JSON serializable");
}

function digestInput(input: RuntimeOperationalCheckpointInput): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(input), "utf8").digest("hex")}`;
}

function assertTimestamp(value: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError("checkpoint.capturedAt must be an ISO timestamp");
}

function assertCounter(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

function assertJson(value: unknown, name: string): void {
  try { clone(value); } catch (error) { throw new TypeError(`${name} must be JSON serializable`, { cause: error }); }
}

function checkedInput<T>(value: RuntimeOperationalCheckpointInput<T>): RuntimeOperationalCheckpointInput<T> {
  if (value === null || typeof value !== "object") throw new TypeError("checkpoint must be an object");
  if (value.format !== RUNTIME_CHECKPOINT_FORMAT || value.version !== RUNTIME_CHECKPOINT_VERSION) throw new Error("unsupported PREMiSE runtime checkpoint");
  assertTimestamp(value.capturedAt);
  if (!Array.isArray(value.activeRecords)) throw new TypeError("checkpoint.activeRecords must be an array");
  assertCounter(value.eventCursor, "checkpoint.eventCursor");
  assertCounter(value.receiptEpoch, "checkpoint.receiptEpoch");
  assertJson(value.activeRecords, "checkpoint.activeRecords");
  assertJson(value.frontierState, "checkpoint.frontierState");
  assertJson(value.incarnations, "checkpoint.incarnations");
  assertJson(value.idempotencyState, "checkpoint.idempotencyState");
  assertJson(value.sourceVersions, "checkpoint.sourceVersions");
  assertJson(value.dependencyState, "checkpoint.dependencyState");
  return clone(value);
}

export function runtimeCheckpointDigest<T>(input: RuntimeOperationalCheckpointInput<T>): `sha256:${string}` {
  return digestInput(checkedInput(input));
}

export function createRuntimeCheckpoint<T>(input: RuntimeOperationalCheckpointInput<T>): RuntimeOperationalCheckpoint<T> {
  const checked = checkedInput(input);
  return Object.freeze({ ...checked, digest: digestInput(checked) });
}

export function parseRuntimeCheckpoint<T = unknown>(value: unknown): RuntimeOperationalCheckpoint<T> {
  if (value === null || typeof value !== "object") throw new TypeError("checkpoint must be an object");
  const candidate = value as Partial<RuntimeOperationalCheckpoint<T>>;
  if (typeof candidate.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(candidate.digest)) throw new TypeError("checkpoint.digest must be a sha256 digest");
  const { digest: _digest, ...input } = candidate as RuntimeOperationalCheckpointInput<T> & { digest: string };
  const checked = checkedInput(input);
  if (digestInput(checked) !== candidate.digest) throw new Error("checkpoint digest mismatch");
  return Object.freeze({ ...checked, digest: candidate.digest as `sha256:${string}` });
}

export function verifyRuntimeCheckpointRecovery<T>(
  checkpoint: unknown,
  tail: readonly RuntimeCheckpointTailEntry[]
): RuntimeCheckpointRecovery {
  let checked: RuntimeOperationalCheckpoint<T>;
  try { checked = parseRuntimeCheckpoint<T>(checkpoint); } catch { return { status: "INVALID", reason: "CHECKPOINT" }; }
  let expected = checked.eventCursor + 1;
  for (const entry of tail) {
    if (entry === null || typeof entry !== "object" || !Number.isSafeInteger(entry.cursor) || entry.cursor < 0) return { status: "INVALID", reason: "TAIL_CURSOR" };
    if (entry.cursor < expected) return { status: "INVALID", reason: "TAIL_REORDERED" };
    if (entry.cursor > expected) return { status: "INVALID", reason: "TAIL_GAP" };
    expected += 1;
  }
  return { status: "READY", checkpoint: checked, finalCursor: expected - 1 };
}
