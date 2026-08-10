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
}

export type V2SignatureVerificationCode =
  | "INVALID_OPTIONS"
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_ALGORITHM"
  | "UNSIGNED_ENVELOPE"
  | "UNKNOWN_KEY_ID"
  | "INVALID_SIGNATURE_ENCODING"
  | "INVALID_SIGNATURE"
  | "REPLAY";

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

/**
 * Return the stable UTF-8 JSON payload signed by PREMiSE v2 signatures.
 *
 * Object keys are sorted recursively, array order is preserved, and the
 * envelope's `signatures` field is excluded so signatures are detached.
 */
export function canonicalizeMemoryEnvelopeV2(input: unknown): string {
  return canonicalizeUnsignedEnvelope(parseMemoryEnvelopeV2(input));
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

  let canonical: string;
  try {
    canonical = canonicalizeUnsignedEnvelope(envelope);
  } catch (error) {
    return {
      verified: false,
      envelope,
      issues: [{ path: "$", code: "INVALID_ENVELOPE", message: error instanceof Error ? error.message : "envelope cannot be canonicalized" }]
    };
  }

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
      verified = verifySignature(null, Buffer.from(canonical, "utf8"), verificationKey, signatureBytes);
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
  for (const candidate of replayCandidates) {
    let claimed = false;
    try {
      claimed = replayStore.claim(candidate.key);
    } catch {
      claimed = false;
    }
    if (seenReplayKeys.has(candidate.key) || !claimed) {
      issues.push(signatureIssue(candidate.signature, candidate.index, "REPLAY", "signature was already accepted"));
    }
    seenReplayKeys.add(candidate.key);
  }
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
