import { createPublicKey, verify as verifySignature, type KeyObjectLike } from "node:crypto";
import { parseMemoryEnvelopeV2, validateMemoryEnvelopeV2 } from "./v2.js";
import type { DeclaredSignature, MemoryEnvelopeV2, V2ValidationIssue } from "./v2.js";

export const V2_SIGNATURE_ALGORITHM = "ed25519" as const;
export type V2SignatureAlgorithm = typeof V2_SIGNATURE_ALGORITHM;

/** A PEM key, SPKI DER bytes, or a Node public KeyObject-shaped value. */
export interface Ed25519PublicKeyObject {
  readonly type: string;
  readonly asymmetricKeyType?: string;
}

export type Ed25519PublicKey = string | Uint8Array | Ed25519PublicKeyObject;

/** Key material indexed by the exact `DeclaredSignature.keyId`. */
export type V2SignatureKeySource =
  | ReadonlyMap<string, Ed25519PublicKey>
  | Readonly<Record<string, Ed25519PublicKey>>
  | ((keyId: string) => Ed25519PublicKey | undefined);

/** Minimal atomic operation required to reject a previously accepted signature. */
export interface V2SignatureReplayStore {
  claim(key: string): boolean;
  /** Optional all-or-nothing claim for multi-signature envelopes. */
  claimMany?(keys: readonly string[]): boolean;
}

/** A replay claim passed to a durable, asynchronous store. */
export interface V2SignatureReplayClaim {
  readonly key: string;
  readonly tenantId: string;
  readonly signatureId: string;
  readonly keyId: string;
  readonly signedAt: string;
  readonly acceptedAt: string;
  readonly expiresAt: string;
}

/** Atomic replay protection shared by all replicas of a protected service. */
export interface V2SignatureReplayStoreAsync {
  claim(claim: V2SignatureReplayClaim): Promise<boolean>;
  /** Atomically claim the complete signature set or persist none of it. */
  claimMany(claims: readonly V2SignatureReplayClaim[]): Promise<boolean>;
}

/**
 * Process-local replay protection. Use an atomic durable implementation when
 * verification runs across processes or replicas.
 */
export class MemoryV2SignatureReplayStore implements V2SignatureReplayStore {
  readonly #keys = new Set<string>();
  readonly #maxEntries: number;

  constructor(maxEntries = 10_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive safe integer");
    this.#maxEntries = maxEntries;
  }

  claim(key: string): boolean {
    if (typeof key !== "string" || key.length === 0 || this.#keys.has(key)) return false;
    this.#keys.add(key);
    // ponytail: bounded process-local state; inject a shared durable store for multi-replica replay guarantees.
    if (this.#keys.size > this.#maxEntries) this.#keys.delete(this.#keys.values().next().value as string);
    return true;
  }

  claimMany(keys: readonly string[]): boolean {
    if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== "string" || key.length === 0)) return false;
    const unique = new Set(keys);
    if (unique.size !== keys.length || keys.some((key) => this.#keys.has(key))) return false;
    for (const key of keys) this.#keys.add(key);
    while (this.#keys.size > this.#maxEntries) this.#keys.delete(this.#keys.values().next().value as string);
    return true;
  }
}

export type V2SignatureVerificationCode =
  | "INVALID_OPTIONS"
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_ALGORITHM"
  | "UNSIGNED_ENVELOPE"
  | "UNKNOWN_KEY_ID"
  | "INVALID_SIGNATURE_ENCODING"
  | "INVALID_SIGNATURE"
  | "REPLAY"
  | "REPLAY_STORE_UNAVAILABLE"
  | "SIGNATURE_TIME_INVALID";

export interface V2SignatureVerificationIssue {
  readonly path: string;
  readonly code: V2SignatureVerificationCode;
  readonly message: string;
}

type V2SignatureKeyOptions =
  | {
    /** Required trust source. A Map is preferred because it has no prototype keys. */
    readonly keys: V2SignatureKeySource;
    readonly keyResolver?: never;
  }
  | {
    /** Alternate callback form for key lookup by keyId. */
    readonly keyResolver: (keyId: string) => Ed25519PublicKey | undefined;
    readonly keys?: never;
  };

export type V2SignatureVerificationOptions = V2SignatureKeyOptions & {
  /** Defaults to a bounded process-local store. */
  readonly replayStore?: V2SignatureReplayStore;
};

export type V2SignatureVerificationAsyncOptions = V2SignatureKeyOptions & {
  readonly replayStore: V2SignatureReplayStoreAsync;
  /** Maximum absolute age/skew allowed for signedAt. Defaults to five minutes. */
  readonly maxClockSkewMs?: number;
  /** Clock injection for deterministic tests and controlled deployments. */
  readonly now?: () => string | number | Date;
};

export interface V2SignatureVerificationResult {
  readonly verified: boolean;
  readonly envelope?: MemoryEnvelopeV2;
  readonly issues: readonly V2SignatureVerificationIssue[];
}

export class V2SignatureVerificationError extends Error {
  readonly issues: readonly V2SignatureVerificationIssue[];

  constructor(issues: readonly V2SignatureVerificationIssue[]) {
    super(`Invalid PREMiSE v2 signature set (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "V2SignatureVerificationError";
    this.issues = issues;
  }
}

const defaultReplayStore = new MemoryV2SignatureReplayStore();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalFragment(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical envelope contains a non-finite number");
    return JSON.stringify(value);
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") throw new TypeError("canonical envelope contains a non-JSON value");
  if (typeof value !== "object") throw new TypeError("canonical envelope contains an unsupported value");
  if (seen.has(value)) throw new TypeError("canonical envelope cannot contain cycles");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${Array.from(value, (item) => canonicalFragment(item, seen)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical envelope must contain plain objects");
    const record = value as Record<string, unknown>;
    result = `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalFragment(record[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function unsignedEnvelope(envelope: MemoryEnvelopeV2): Record<string, unknown> {
  const { signatures: _signatures, ...unsigned } = envelope;
  return unsigned;
}

function canonicalizeUnsignedEnvelope(envelope: MemoryEnvelopeV2): string {
  return canonicalFragment(unsignedEnvelope(envelope), new Set<object>());
}

const SIGNATURE_DOMAIN = "premise/memory-envelope-signature/v2" as const;

export type V2SignatureMetadata = Omit<DeclaredSignature, "value"> | Readonly<{
  signatureId: string;
  signerId: string;
  keyId: string;
  algorithm: "ed25519";
  signedAt: string;
  evidenceId?: string;
}>;

function signatureMetadata(signature: V2SignatureMetadata): Record<string, unknown> {
  return {
    signatureId: signature.signatureId,
    signerId: signature.signerId,
    keyId: signature.keyId,
    algorithm: signature.algorithm,
    signedAt: signature.signedAt,
    ...(signature.evidenceId === undefined ? {} : { evidenceId: signature.evidenceId })
  };
}

function canonicalizeSignature(envelope: MemoryEnvelopeV2, signature: V2SignatureMetadata): string {
  return canonicalFragment({
    domain: SIGNATURE_DOMAIN,
    envelope: unsignedEnvelope(envelope),
    signature: signatureMetadata(signature)
  }, new Set<object>());
}

/**
 * Return the stable UTF-8 JSON payload signed by PREMiSE v2 signatures.
 *
 * Object keys are sorted recursively, array order is preserved, and the
 * envelope's `signatures` field is excluded so signatures are detached.
 */
export function canonicalizeMemoryEnvelopeV2(input: unknown): string {
  return canonicalizeUnsignedEnvelope(parseMemoryEnvelopeV2(input));
}

/**
 * Return the stable UTF-8 payload for one detached signature. The signature
 * value is intentionally excluded, but every other declaration field is
 * bound to the envelope with domain separation. Use this function when
 * producing `DeclaredSignature.value` and when verifying it.
 */
export function canonicalizeMemoryEnvelopeV2Signature(input: unknown, signature: V2SignatureMetadata): string {
  return canonicalizeSignature(parseMemoryEnvelopeV2(input), signature);
}

function resolveKey(source: V2SignatureKeySource, keyId: string): Ed25519PublicKey | undefined {
  try {
    if (typeof source === "function") return source(keyId);
    if (typeof (source as { get?: unknown }).get === "function") return (source as ReadonlyMap<string, Ed25519PublicKey>).get(keyId);
    if (isRecord(source) && Object.prototype.hasOwnProperty.call(source, keyId)) return source[keyId] as Ed25519PublicKey;
    return undefined;
  } catch {
    return undefined;
  }
}

function publicKey(value: Ed25519PublicKey | undefined): KeyObjectLike | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const key = value instanceof Uint8Array
      ? createPublicKey({ key: value, format: "der", type: "spki" })
      : typeof value === "string"
        ? createPublicKey(value)
        : value as KeyObjectLike;
    return key.type === "public" && key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length > 128 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? new Uint8Array(decoded) : undefined;
}

function structuralIssues(input: unknown): V2SignatureVerificationIssue[] {
  return validateMemoryEnvelopeV2(input).map(({ path, message }: V2ValidationIssue) => ({
    path,
    code: path.endsWith(".algorithm") ? "UNSUPPORTED_ALGORITHM" : "INVALID_ENVELOPE",
    message
  }));
}

function optionsIssues(options: V2SignatureVerificationOptions | undefined): V2SignatureVerificationIssue[] {
  if (!isRecord(options)) return [{ path: "$.options", code: "INVALID_OPTIONS", message: "verification options are required" }];
  if (options.keys !== undefined && options.keyResolver !== undefined) return [{ path: "$.options", code: "INVALID_OPTIONS", message: "provide keys or keyResolver, not both" }];
  if (options.keys === undefined && options.keyResolver === undefined) return [{ path: "$.options.keys", code: "INVALID_OPTIONS", message: "a key source is required" }];
  const replayStore = options.replayStore;
  if (replayStore !== undefined && (!isRecord(replayStore) || typeof (replayStore as { claim?: unknown }).claim !== "function")) return [{ path: "$.options.replayStore", code: "INVALID_OPTIONS", message: "replayStore must implement claim(key)" }];
  return [];
}

function signatureIssue(signature: DeclaredSignature, index: number, code: V2SignatureVerificationCode, message: string): V2SignatureVerificationIssue {
  return { path: `$.signatures[${index}]`, code, message: `${signature.signatureId}: ${message}` };
}

/**
 * Verify every declared PREMiSE v2 signature using the public key selected by
 * its `keyId`. Verification is fail-closed and claims each valid signature in
 * the replay store only after all cryptographic checks pass.
 */
export function verifyMemoryEnvelopeV2Signatures(input: unknown, options: V2SignatureVerificationOptions): V2SignatureVerificationResult {
  const optionIssues = optionsIssues(options);
  if (optionIssues.length > 0) return { verified: false, issues: optionIssues };
  const issues = structuralIssues(input);
  if (issues.length > 0) return { verified: false, issues };
  const envelope = input as MemoryEnvelopeV2;
  if (envelope.signatures.length === 0) return {
    verified: false,
    envelope,
    issues: [{ path: "$.signatures", code: "UNSIGNED_ENVELOPE", message: "at least one Ed25519 signature is required" }]
  };

  const source: V2SignatureKeySource = options?.keyResolver !== undefined ? options.keyResolver : options?.keys as V2SignatureKeySource;
  const replayStore = options?.replayStore ?? defaultReplayStore;
  const replayCandidates: Array<{ readonly index: number; readonly signature: DeclaredSignature; readonly key: string }> = [];
  for (const [index, signature] of envelope.signatures.entries()) {
    const key = resolveKey(source, signature.keyId);
    if (key === undefined) {
      issues.push(signatureIssue(signature, index, "UNKNOWN_KEY_ID", `no public key is configured for keyId ${signature.keyId}`));
      continue;
    }
    const signatureBytes = decodeBase64(signature.value);
    if (signatureBytes === undefined || signatureBytes.length !== 64) {
      issues.push(signatureIssue(signature, index, "INVALID_SIGNATURE_ENCODING", "value must be canonical base64 for a 64-byte Ed25519 signature"));
      continue;
    }
    const verificationKey = publicKey(key);
    if (verificationKey === undefined) {
      issues.push(signatureIssue(signature, index, "INVALID_SIGNATURE", "keyId does not resolve to a public Ed25519 key"));
      continue;
    }
    let verified = false;
    try {
      verified = verifySignature(null, Buffer.from(canonicalizeSignature(envelope, signature), "utf8"), verificationKey, signatureBytes);
    } catch {
      verified = false;
    }
    if (!verified) {
      issues.push(signatureIssue(signature, index, "INVALID_SIGNATURE", "Ed25519 verification failed"));
      continue;
    }
    replayCandidates.push({ index, signature, key: signature.value });
  }
  if (issues.length > 0) return { verified: false, envelope, issues };

  const seenReplayKeys = new Set<string>();
  const duplicateCandidates = replayCandidates.filter((candidate) => {
    if (seenReplayKeys.has(candidate.key)) return true;
    seenReplayKeys.add(candidate.key);
    return false;
  });
  for (const candidate of duplicateCandidates) issues.push(signatureIssue(candidate.signature, candidate.index, "REPLAY", "signature was declared more than once"));
  if (issues.length > 0) return { verified: false, envelope, issues };
  let claimed = false;
  try {
    claimed = typeof replayStore.claimMany === "function"
      ? replayStore.claimMany(replayCandidates.map((candidate) => candidate.key))
      : replayCandidates.every((candidate) => replayStore.claim(candidate.key));
  } catch {
    claimed = false;
  }
  if (!claimed) for (const candidate of replayCandidates) issues.push(signatureIssue(candidate.signature, candidate.index, "REPLAY", "one or more signatures were already accepted"));
  return issues.length === 0 ? { verified: true, envelope, issues: [] } : { verified: false, envelope, issues };
}

/** Return only the fail-closed verification decision. */
export function verifyMemoryEnvelopeV2(input: unknown, options: V2SignatureVerificationOptions): boolean {
  return verifyMemoryEnvelopeV2Signatures(input, options).verified;
}

/** Verify signatures and throw when the envelope cannot be trusted. */
export function parseAndVerifyMemoryEnvelopeV2(input: unknown, options: V2SignatureVerificationOptions): MemoryEnvelopeV2 {
  const result = verifyMemoryEnvelopeV2Signatures(input, options);
  if (!result.verified || result.envelope === undefined) throw new V2SignatureVerificationError(result.issues);
  return result.envelope;
}

function asyncOptionsIssues(options: V2SignatureVerificationAsyncOptions | undefined): V2SignatureVerificationIssue[] {
  if (!isRecord(options)) return [{ path: "$.options", code: "INVALID_OPTIONS", message: "verification options are required" }];
  const keyIssues = optionsIssues(options as unknown as V2SignatureVerificationOptions);
  if (keyIssues.length > 0) return keyIssues;
  if (!isRecord(options.replayStore) || typeof (options.replayStore as { claim?: unknown }).claim !== "function" || typeof (options.replayStore as { claimMany?: unknown }).claimMany !== "function") {
    return [{ path: "$.options.replayStore", code: "INVALID_OPTIONS", message: "replayStore must implement async claim(claim) and atomic claimMany(claims)" }];
  }
  const maxClockSkewMs = options.maxClockSkewMs ?? 5 * 60 * 1_000;
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 1 || maxClockSkewMs > 24 * 60 * 60 * 1_000) {
    return [{ path: "$.options.maxClockSkewMs", code: "INVALID_OPTIONS", message: "maxClockSkewMs must be a safe integer from 1 to 86400000" }];
  }
  return [];
}

function clockValue(value: string | number | Date | undefined): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Verify signatures with a durable asynchronous replay store and an explicit
 * signedAt freshness window. This additive API is the production path for
 * multi-replica services; the synchronous verifier remains for embedded and
 * backwards-compatible local integrations.
 */
export async function verifyMemoryEnvelopeV2SignaturesAsync(
  input: unknown,
  options: V2SignatureVerificationAsyncOptions
): Promise<V2SignatureVerificationResult> {
  const optionIssues = asyncOptionsIssues(options);
  if (optionIssues.length > 0) return { verified: false, issues: optionIssues };
  const issues = structuralIssues(input);
  if (issues.length > 0) return { verified: false, issues };
  const envelope = input as MemoryEnvelopeV2;
  if (envelope.signatures.length === 0) return {
    verified: false,
    envelope,
    issues: [{ path: "$.signatures", code: "UNSIGNED_ENVELOPE", message: "at least one Ed25519 signature is required" }]
  };

  const nowMs = clockValue(options.now?.() ?? Date.now());
  const maxClockSkewMs = options.maxClockSkewMs ?? 5 * 60 * 1_000;
  if (nowMs === undefined) return {
    verified: false,
    envelope,
    issues: [{ path: "$.options.now", code: "INVALID_OPTIONS", message: "now must resolve to a finite timestamp" }]
  };
  const source: V2SignatureKeySource = options.keyResolver !== undefined ? options.keyResolver : options.keys as V2SignatureKeySource;
  const replayCandidates: Array<{ readonly index: number; readonly signature: DeclaredSignature; readonly signedAtMs: number }> = [];
  for (const [index, signature] of envelope.signatures.entries()) {
    const signedAtMs = Date.parse(signature.signedAt);
    if (!Number.isFinite(signedAtMs) || Math.abs(nowMs - signedAtMs) > maxClockSkewMs) {
      issues.push(signatureIssue(signature, index, "SIGNATURE_TIME_INVALID", `signedAt is outside the allowed ${maxClockSkewMs} ms clock window`));
      continue;
    }
    const key = resolveKey(source, signature.keyId);
    if (key === undefined) {
      issues.push(signatureIssue(signature, index, "UNKNOWN_KEY_ID", `no public key is configured for keyId ${signature.keyId}`));
      continue;
    }
    const signatureBytes = decodeBase64(signature.value);
    if (signatureBytes === undefined || signatureBytes.length !== 64) {
      issues.push(signatureIssue(signature, index, "INVALID_SIGNATURE_ENCODING", "value must be canonical base64 for a 64-byte Ed25519 signature"));
      continue;
    }
    const verificationKey = publicKey(key);
    if (verificationKey === undefined) {
      issues.push(signatureIssue(signature, index, "INVALID_SIGNATURE", "keyId does not resolve to a public Ed25519 key"));
      continue;
    }
    let verified = false;
    try {
      verified = verifySignature(null, Buffer.from(canonicalizeSignature(envelope, signature), "utf8"), verificationKey, signatureBytes);
    } catch {
      verified = false;
    }
    if (!verified) {
      issues.push(signatureIssue(signature, index, "INVALID_SIGNATURE", "Ed25519 verification failed"));
      continue;
    }
    replayCandidates.push({ index, signature, signedAtMs });
  }
  if (issues.length > 0) return { verified: false, envelope, issues };

  const seenReplayKeys = new Set<string>();
  const duplicateCandidates = replayCandidates.filter((candidate) => {
    if (seenReplayKeys.has(candidate.signature.value)) return true;
    seenReplayKeys.add(candidate.signature.value);
    return false;
  });
  for (const candidate of duplicateCandidates) issues.push(signatureIssue(candidate.signature, candidate.index, "REPLAY", "signature was declared more than once"));
  if (issues.length > 0) return { verified: false, envelope, issues };
  const claims = replayCandidates.map((candidate) => ({
    key: candidate.signature.value,
    tenantId: envelope.tenantId,
    signatureId: candidate.signature.signatureId,
    keyId: candidate.signature.keyId,
    signedAt: candidate.signature.signedAt,
    acceptedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + maxClockSkewMs).toISOString()
  }));
  try {
    if (!await options.replayStore.claimMany(claims)) {
      for (const candidate of replayCandidates) issues.push(signatureIssue(candidate.signature, candidate.index, "REPLAY", "one or more signatures were already accepted"));
    }
  } catch (error) {
    for (const candidate of replayCandidates) issues.push(signatureIssue(candidate.signature, candidate.index, "REPLAY_STORE_UNAVAILABLE", `durable replay store failed closed: ${error instanceof Error ? error.message : "unknown store error"}`));
  }
  return issues.length === 0 ? { verified: true, envelope, issues: [] } : { verified: false, envelope, issues };
}

export async function verifyMemoryEnvelopeV2Async(input: unknown, options: V2SignatureVerificationAsyncOptions): Promise<boolean> {
  return (await verifyMemoryEnvelopeV2SignaturesAsync(input, options)).verified;
}

export async function parseAndVerifyMemoryEnvelopeV2Async(input: unknown, options: V2SignatureVerificationAsyncOptions): Promise<MemoryEnvelopeV2> {
  const result = await verifyMemoryEnvelopeV2SignaturesAsync(input, options);
  if (!result.verified || result.envelope === undefined) throw new V2SignatureVerificationError(result.issues);
  return result.envelope;
}
