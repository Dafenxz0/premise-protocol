import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyLike as NodeKeyLike
} from "node:crypto";

export const ENCRYPTED_PAYLOAD_FORMAT = "premise-encrypted-payload" as const;
export const ENCRYPTED_PAYLOAD_VERSION = 1 as const;
export const AUDIT_LOG_FORMAT = "premise-security-audit/1" as const;
export const AUDIT_LOG_VERSION = 1 as const;
export const AUDIT_GENESIS_HASH = "sha256:genesis" as const;
export const REDACTED = "[REDACTED]" as const;

export type SecurityErrorCode =
  | "INVALID_INPUT"
  | "CONFIGURATION_ERROR"
  | "SIGNING_FAILED"
  | "DECRYPTION_FAILED"
  | "KEY_ID_REUSE"
  | "ACCESS_DENIED"
  | "AUDIT_INTEGRITY_ERROR";

export class SecurityError extends Error {
  readonly code: SecurityErrorCode;

  constructor(code: SecurityErrorCode, message: string) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
  }
}

export class AccessDeniedError extends SecurityError {
  constructor() {
    super("ACCESS_DENIED", "Access denied");
    this.name = "AccessDeniedError";
  }
}

function invalid(message: string): never {
  throw new SecurityError("INVALID_INPUT", message);
}

function configuration(message: string): never {
  throw new SecurityError("CONFIGURATION_ERROR", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printable(value: string, label: string, maxLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value !== value.trim() || !/^[\x21-\x7e]+$/.test(value)) invalid(`${label} must be a printable non-empty value`);
  return value;
}

function identifier(value: string, label: string, allowWildcard = false): string {
  const result = printable(value, label, 256);
  if (!allowWildcard && result === "*") invalid(`${label} cannot be a wildcard`);
  return result;
}

function bytes(value: string | Uint8Array): Uint8Array {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) invalid("security bytes must be text or Uint8Array");
  return typeof value === "string" ? new Uint8Array(Buffer.from(value, "utf8")) : new Uint8Array(value);
}

function base64Encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function base64Decode(value: string, label: string, allowEmpty = false): Uint8Array {
  if ((!allowEmpty && value.length === 0) || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalid(`${label} must be valid base64`);
  const decoded = new Uint8Array(Buffer.from(value, "base64"));
  if (base64Encode(decoded) !== value) invalid(`${label} must use canonical base64`);
  return decoded;
}

function hexDecode(value: string, label: string): Uint8Array {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) invalid(`${label} must be valid hexadecimal`);
  const decoded = new Uint8Array(value.length / 2);
  for (let index = 0; index < decoded.length; index += 1) decoded[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return decoded;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  const paddedLeft = new Uint8Array(length);
  const paddedRight = new Uint8Array(length);
  paddedLeft.set(left);
  paddedRight.set(right);
  const equal = timingSafeEqual(paddedLeft, paddedRight);
  return equal && left.length === right.length;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalFragment(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("canonical payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") invalid("canonical payload cannot contain undefined");
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") invalid("canonical payload contains an unsupported value");
  if (value instanceof Uint8Array) return `{"$bytes":${JSON.stringify(base64Encode(value))}}`;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) invalid("canonical payload contains an invalid date");
    return JSON.stringify(value.toISOString());
  }
  if (typeof value !== "object") invalid("canonical payload contains an unsupported value");
  if (seen.has(value)) invalid("canonical payload cannot contain cycles");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${Array.from(value, (item) => canonicalFragment(item, seen)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("canonical payload must contain plain objects");
    const record = value as Record<string, unknown>;
    result = `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalFragment(record[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}

/** Stable JSON used by signatures, encrypted payloads, and audit hashes. */
export function canonicalize(value: unknown): string {
  return canonicalFragment(value, new Set<object>());
}

function securityPayloadBytes(value: unknown): Uint8Array {
  return typeof value === "string" || value instanceof Uint8Array ? bytes(value) : bytes(canonicalize(value));
}

export interface Ed25519KeyObject {
  readonly type: string;
  readonly asymmetricKeyType?: string;
}

export type Ed25519Key = Ed25519KeyObject | string | Uint8Array;

export interface Ed25519KeyPair {
  readonly publicKey: Ed25519KeyObject;
  readonly privateKey: Ed25519KeyObject;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey as unknown as Ed25519KeyObject,
    privateKey: pair.privateKey as unknown as Ed25519KeyObject
  };
}

export function signEd25519(payload: unknown, privateKey: Ed25519Key): string {
  if (privateKey === undefined || privateKey === null) invalid("an Ed25519 private key is required");
  try {
    return base64Encode(sign(null, securityPayloadBytes(payload), privateKey as NodeKeyLike));
  } catch {
    throw new SecurityError("SIGNING_FAILED", "Ed25519 signing failed");
  }
}

export function verifyEd25519(payload: unknown, signature: string, publicKey: Ed25519Key): boolean {
  if (typeof signature !== "string" || publicKey === undefined || publicKey === null) return false;
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64Decode(signature, "signature");
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) return false;
  try {
    return verify(null, securityPayloadBytes(payload), publicKey as NodeKeyLike, signatureBytes);
  } catch {
    return false;
  }
}

export const signPayload = signEd25519;
export const verifyPayload = verifyEd25519;

export type WebhookPayload = string | Uint8Array;
export type WebhookSecret = string | Uint8Array;

function secretBytes(secret: WebhookSecret): Uint8Array {
  if (typeof secret !== "string" && !(secret instanceof Uint8Array)) configuration("webhook secret must be text or Uint8Array");
  const result = bytes(secret);
  if (result.length === 0) configuration("webhook secret must not be empty");
  return result;
}

export function hmacSha256(payload: WebhookPayload, secret: WebhookSecret): string {
  return createHmac("sha256", secretBytes(secret)).update(bytes(payload)).digest("hex");
}

export function signWebhook(payload: WebhookPayload, secret: WebhookSecret): string {
  return `sha256=${hmacSha256(payload, secret)}`;
}

export function verifyWebhookSignature(payload: WebhookPayload, signature: string | undefined, secret: WebhookSecret | undefined): boolean {
  if (secret === undefined || signature === undefined || typeof signature !== "string") return false;
  let expected: Uint8Array;
  try {
    expected = hexDecode(hmacSha256(payload, secret), "HMAC");
  } catch {
    return false;
  }
  const normalized = signature.trim().toLowerCase();
  const validShape = /^sha256=[0-9a-f]{64}$/.test(normalized);
  const actual = validShape ? hexDecode(normalized.slice("sha256=".length), "HMAC") : new Uint8Array(expected.length);
  return constantTimeEqual(expected, actual) && validShape;
}

export interface WebhookSigningMetadata {
  readonly deliveryId: string;
  readonly timestamp?: string | number;
}

function normalizedWebhookMetadata(metadata: WebhookSigningMetadata): Record<string, unknown> {
  const deliveryId = identifier(metadata.deliveryId, "deliveryId");
  if (metadata.timestamp === undefined) return { deliveryId };
  if (typeof metadata.timestamp === "number" && Number.isFinite(metadata.timestamp)) return { deliveryId, timestamp: metadata.timestamp };
  if (typeof metadata.timestamp === "string") return { deliveryId, timestamp: printable(metadata.timestamp, "timestamp", 128) };
  invalid("timestamp must be a finite number or printable string");
}

function webhookSigningBytes(payload: WebhookPayload, metadata: WebhookSigningMetadata): Uint8Array {
  return bytes(canonicalize({ payload: base64Encode(bytes(payload)), ...normalizedWebhookMetadata(metadata) }));
}

export function signWebhookRequest(payload: WebhookPayload, secret: WebhookSecret, metadata: WebhookSigningMetadata): string {
  return signWebhook(webhookSigningBytes(payload, metadata), secret);
}

export function verifyWebhookRequest(payload: WebhookPayload, signature: string | undefined, secret: WebhookSecret | undefined, metadata: WebhookSigningMetadata): boolean {
  try {
    return verifyWebhookSignature(webhookSigningBytes(payload, metadata), signature, secret);
  } catch {
    return false;
  }
}

export interface ReplayStore {
  claim(key: string, expiresAt: number, now: number): boolean;
}

// ponytail: in-memory replay state; inject an atomic shared TTL store for multi-replica deployments.
export class MemoryReplayStore implements ReplayStore {
  #entries = new Map<string, number>();

  claim(key: string, expiresAt: number, now: number): boolean {
    for (const [storedKey, storedExpiry] of this.#entries) if (storedExpiry <= now) this.#entries.delete(storedKey);
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing > now) return false;
    this.#entries.set(key, expiresAt);
    return true;
  }
}

export interface ReplayGuardOptions {
  readonly ttlMs?: number;
  readonly maxClockSkewMs?: number;
  readonly now?: () => number;
  readonly store?: ReplayStore;
}

export class ReplayGuard {
  private readonly ttlMs: number;
  private readonly maxClockSkewMs: number;
  private readonly now: () => number;
  private readonly store: ReplayStore;

  constructor(options: ReplayGuardOptions = {}) {
    this.ttlMs = options.ttlMs ?? 300_000;
    this.maxClockSkewMs = options.maxClockSkewMs ?? 300_000;
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? new MemoryReplayStore();
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || !Number.isSafeInteger(this.maxClockSkewMs) || this.maxClockSkewMs < 0) configuration("replay timing values are invalid");
  }

  claim(key: string, timestamp?: string | number): boolean {
    let replayKey: string;
    try {
      replayKey = identifier(key, "replay key");
    } catch {
      return false;
    }
    const now = this.now();
    if (!Number.isFinite(now)) return false;
    const occurredAt = timestamp === undefined ? now : typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
    if (!Number.isFinite(occurredAt) || Math.abs(now - occurredAt) > this.maxClockSkewMs) return false;
    return this.store.claim(replayKey, now + this.ttlMs, now);
  }
}

export interface WebhookVerificationRequest {
  readonly payload: WebhookPayload;
  readonly signature?: string;
  readonly deliveryId?: string;
  readonly timestamp?: string | number;
}

export interface WebhookVerifierOptions {
  readonly secret: WebhookSecret;
  readonly replayGuard?: ReplayGuard;
  readonly bindMetadata?: boolean;
}

export class WebhookVerifier {
  #secret: WebhookSecret;
  #replayGuard: ReplayGuard | undefined;
  #bindMetadata: boolean;

  constructor(options: WebhookVerifierOptions) {
    this.#secret = secretBytes(options.secret);
    this.#replayGuard = options.replayGuard;
    this.#bindMetadata = options.bindMetadata ?? false;
  }

  verify(request: WebhookVerificationRequest): boolean {
    const hasMetadata = request.deliveryId !== undefined;
    const authenticated = this.#bindMetadata
      ? hasMetadata && verifyWebhookRequest(request.payload, request.signature, this.#secret, {
        deliveryId: request.deliveryId as string,
        ...(request.timestamp === undefined ? {} : { timestamp: request.timestamp })
      })
      : verifyWebhookSignature(request.payload, request.signature, this.#secret);
    if (!authenticated || this.#replayGuard === undefined) return authenticated;

    const bodyKey = `body:${digestBytes(bytes(request.payload))}`;
    if (!this.#replayGuard.claim(bodyKey, request.timestamp)) return false;
    if (request.deliveryId !== undefined && !this.#replayGuard.claim(`delivery:${request.deliveryId}`, request.timestamp)) return false;
    return true;
  }

  require(request: WebhookVerificationRequest): void {
    if (!this.verify(request)) throw new SecurityError("ACCESS_DENIED", "Webhook authentication failed");
  }
}

export interface EncryptedPayload {
  readonly format: typeof ENCRYPTED_PAYLOAD_FORMAT;
  readonly version: typeof ENCRYPTED_PAYLOAD_VERSION;
  readonly algorithm: "aes-256-gcm";
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
  readonly aad?: string;
}

export interface PayloadEncryptionOptions {
  readonly keyId: string;
  readonly key: Uint8Array;
  readonly aad?: string | Uint8Array;
  readonly associatedData?: string | Uint8Array;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface PayloadDecryptionOptions {
  readonly key: Uint8Array;
  readonly expectedAssociatedData?: string | Uint8Array;
}

function aesKey(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) configuration("AES-256-GCM keys must contain 32 bytes");
  return new Uint8Array(value);
}

function aadBytes(options: Pick<PayloadEncryptionOptions, "aad" | "associatedData">): Uint8Array {
  if (options.aad !== undefined && options.associatedData !== undefined) {
    if (!constantTimeEqual(bytes(options.aad), bytes(options.associatedData))) invalid("aad and associatedData must match");
  }
  return bytes(options.aad ?? options.associatedData ?? new Uint8Array());
}

function encryptedPayload(input: unknown): EncryptedPayload {
  if (!isRecord(input) || input.format !== ENCRYPTED_PAYLOAD_FORMAT || input.version !== ENCRYPTED_PAYLOAD_VERSION || input.algorithm !== "aes-256-gcm") invalid("encrypted payload header is invalid");
  if (typeof input.keyId !== "string" || typeof input.iv !== "string" || typeof input.ciphertext !== "string" || typeof input.authTag !== "string") invalid("encrypted payload fields are invalid");
  if (input.aad !== undefined && typeof input.aad !== "string") invalid("encrypted payload aad is invalid");
  identifier(input.keyId, "keyId");
  const iv = base64Decode(input.iv, "encrypted payload iv");
  base64Decode(input.ciphertext, "encrypted payload ciphertext", true);
  const authTag = base64Decode(input.authTag, "encrypted payload authTag");
  if (iv.length !== 12 || authTag.length !== 16) invalid("encrypted payload AES-GCM parameters are invalid");
  if (input.aad !== undefined) base64Decode(input.aad, "encrypted payload aad", true);
  return input as unknown as EncryptedPayload;
}

export function isEncryptedPayload(input: unknown): input is EncryptedPayload {
  try {
    encryptedPayload(input);
    return true;
  } catch {
    return false;
  }
}

export function generateAes256Key(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

export function encryptPayload(payload: unknown, options: PayloadEncryptionOptions): EncryptedPayload {
  const keyId = identifier(options.keyId, "keyId");
  const key = aesKey(options.key);
  const aad = aadBytes(options);
  const iv = new Uint8Array((options.randomBytes ?? randomBytes)(12));
  if (iv.length !== 12) configuration("AES-256-GCM IVs must contain 12 bytes");
  const serialized = bytes(canonicalize(payload));
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    if (aad.length > 0) cipher.setAAD(aad);
    const ciphertext = new Uint8Array(Buffer.concat([cipher.update(serialized), cipher.final()]));
    const authTag = new Uint8Array(cipher.getAuthTag());
    if (authTag.length !== 16) throw new Error("unexpected authentication tag length");
    return Object.freeze({
      format: ENCRYPTED_PAYLOAD_FORMAT,
      version: ENCRYPTED_PAYLOAD_VERSION,
      algorithm: "aes-256-gcm",
      keyId,
      iv: base64Encode(iv),
      ciphertext: base64Encode(ciphertext),
      authTag: base64Encode(authTag),
      ...(aad.length === 0 ? {} : { aad: base64Encode(aad) })
    });
  } catch {
    throw new SecurityError("DECRYPTION_FAILED", "Payload encryption failed");
  }
}

export function decryptPayload<T = unknown>(input: EncryptedPayload, options: PayloadDecryptionOptions): T {
  try {
    const envelope = encryptedPayload(input);
    const key = aesKey(options.key);
    const iv = base64Decode(envelope.iv, "encrypted payload iv");
    const ciphertext = base64Decode(envelope.ciphertext, "encrypted payload ciphertext", true);
    const authTag = base64Decode(envelope.authTag, "encrypted payload authTag");
    if (iv.length !== 12 || authTag.length !== 16) throw new Error("invalid AES-GCM parameters");
    const aad = envelope.aad === undefined ? new Uint8Array() : base64Decode(envelope.aad, "encrypted payload aad", true);
    if (options.expectedAssociatedData !== undefined && !constantTimeEqual(aad, bytes(options.expectedAssociatedData))) throw new Error("AAD mismatch");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    if (aad.length > 0) decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const plaintext = new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    return JSON.parse(Buffer.from(plaintext).toString("utf8")) as T;
  } catch (error) {
    if (error instanceof SecurityError && error.code === "INVALID_INPUT") throw new SecurityError("DECRYPTION_FAILED", "Payload authentication failed");
    throw new SecurityError("DECRYPTION_FAILED", "Payload authentication failed");
  }
}

export interface EncryptionKey {
  readonly keyId: string;
  readonly key: Uint8Array;
}

export interface KeyRingOptions {
  readonly activeKey: EncryptionKey;
  readonly previousKeys?: readonly EncryptionKey[];
  readonly randomBytes?: (size: number) => Uint8Array;
}

export class KeyRing {
  #keys = new Map<string, Uint8Array>();
  #randomBytes: (size: number) => Uint8Array;
  #activeId: string;

  constructor(options: KeyRingOptions) {
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#activeId = "";
    for (const key of options.previousKeys ?? []) this.addKey(key);
    this.addKey(options.activeKey, true);
  }

  get activeKeyId(): string {
    return this.#activeId;
  }

  get keyCount(): number {
    return this.#keys.size;
  }

  hasKey(keyId: string): boolean {
    return this.#keys.has(keyId);
  }

  addKey(key: EncryptionKey, activate = false): void {
    const keyId = identifier(key.keyId, "keyId");
    const material = aesKey(key.key);
    const existing = this.#keys.get(keyId);
    if (existing !== undefined && !constantTimeEqual(existing, material)) throw new SecurityError("KEY_ID_REUSE", "keyId cannot be reused with different key material");
    this.#keys.set(keyId, material);
    if (activate) this.#activeId = keyId;
  }

  rotate(key: EncryptionKey): void {
    this.addKey(key, true);
  }

  retire(keyId: string): void {
    const normalized = identifier(keyId, "keyId");
    if (normalized === this.#activeId) configuration("the active encryption key cannot be retired");
    this.#keys.delete(normalized);
  }

  encrypt(payload: unknown, options: Pick<PayloadEncryptionOptions, "aad" | "associatedData"> = {}): EncryptedPayload {
    if (this.#activeId.length === 0) configuration("an active encryption key is required");
    const key = this.#keys.get(this.#activeId);
    if (key === undefined) configuration("the active encryption key is unavailable");
    return encryptPayload(payload, { keyId: this.#activeId, key, randomBytes: this.#randomBytes, ...options });
  }

  decrypt<T = unknown>(payload: EncryptedPayload, options: Pick<PayloadDecryptionOptions, "expectedAssociatedData"> = {}): T {
    const envelope = encryptedPayload(payload);
    const key = this.#keys.get(envelope.keyId);
    if (key === undefined) throw new SecurityError("DECRYPTION_FAILED", "Payload authentication failed");
    return decryptPayload<T>(envelope, { key, ...options });
  }
}

export type AclEffect = "allow" | "deny";

export interface AclRule {
  readonly effect: AclEffect;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly action: string;
  readonly resource?: string;
}

export interface AclRequest {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly action: string;
  readonly resource?: string;
}

export interface AclDecision {
  readonly allowed: boolean;
  readonly reason: "explicit-allow" | "explicit-deny" | "default-deny" | "default-allow";
  readonly matchedRule?: AclRule;
}

export interface AclPolicyOptions {
  readonly rules: readonly AclRule[];
  readonly defaultEffect?: AclEffect;
}

function aclValue(value: string, label: string): string {
  return identifier(value, label, true);
}

function normalizeAclRule(rule: AclRule): AclRule {
  if (!isRecord(rule) || (rule.effect !== "allow" && rule.effect !== "deny") || typeof rule.tenantId !== "string" || typeof rule.subjectId !== "string" || typeof rule.action !== "string" || (rule.resource !== undefined && typeof rule.resource !== "string")) invalid("ACL rule is invalid");
  const normalized: AclRule = {
    effect: rule.effect,
    tenantId: aclValue(rule.tenantId, "tenantId"),
    subjectId: aclValue(rule.subjectId, "subjectId"),
    action: aclValue(rule.action, "action"),
    ...(rule.resource === undefined ? {} : { resource: aclValue(rule.resource, "resource") })
  };
  return Object.freeze(normalized);
}

function aclMatches(rule: AclRule, request: AclRequest): boolean {
  return (rule.tenantId === "*" || rule.tenantId === request.tenantId)
    && (rule.subjectId === "*" || rule.subjectId === request.subjectId)
    && (rule.action === "*" || rule.action === request.action)
    && (rule.resource === undefined || rule.resource === "*" || rule.resource === request.resource);
}

export class AclPolicy {
  readonly rules: readonly AclRule[];
  readonly defaultEffect: AclEffect;

  constructor(options: AclPolicyOptions | readonly AclRule[]) {
    const isRuleList = Array.isArray(options);
    if (!isRuleList && (!isRecord(options) || !Array.isArray(options.rules))) invalid("ACL policy is invalid");
    const rules = isRuleList ? options as readonly AclRule[] : (options as AclPolicyOptions).rules;
    this.rules = Object.freeze(rules.map(normalizeAclRule));
    this.defaultEffect = isRuleList ? "deny" : (options as AclPolicyOptions).defaultEffect ?? "deny";
    if (this.defaultEffect !== "allow" && this.defaultEffect !== "deny") configuration("ACL default effect is invalid");
  }

  decide(request: AclRequest): AclDecision {
    if (!isRecord(request) || typeof request.tenantId !== "string" || typeof request.subjectId !== "string" || typeof request.action !== "string" || (request.resource !== undefined && typeof request.resource !== "string")) invalid("ACL request is invalid");
    const tenantId = identifier(request.tenantId, "tenantId");
    const subjectId = identifier(request.subjectId, "subjectId");
    const action = identifier(request.action, "action");
    const resource = request.resource === undefined ? undefined : identifier(request.resource, "resource");
    const normalized: AclRequest = { tenantId, subjectId, action, ...(resource === undefined ? {} : { resource }) };
    const matching = this.rules.filter((rule) => aclMatches(rule, normalized));
    const denied = matching.find((rule) => rule.effect === "deny");
    if (denied !== undefined) return { allowed: false, reason: "explicit-deny", matchedRule: denied };
    const allowed = matching.find((rule) => rule.effect === "allow");
    if (allowed !== undefined) return { allowed: true, reason: "explicit-allow", matchedRule: allowed };
    return this.defaultEffect === "allow" ? { allowed: true, reason: "default-allow" } : { allowed: false, reason: "default-deny" };
  }

  isAllowed(request: AclRequest): boolean {
    return this.decide(request).allowed;
  }

  authorize(request: AclRequest): boolean {
    return this.isAllowed(request);
  }

  assertAuthorized(request: AclRequest): void {
    if (!this.isAllowed(request)) throw new AccessDeniedError();
  }
}

export interface SecretSanitizerOptions {
  readonly secrets?: readonly string[];
  readonly secretValues?: readonly string[];
  readonly maxDepth?: number;
}

const sensitiveKeyFragments = [
  "secret",
  "token",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "credential",
  "signature"
] as const;

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return sensitiveKeyFragments.some((fragment) => normalized.includes(fragment));
}

function secretList(options: SecretSanitizerOptions): readonly string[] {
  const values = [...(options.secrets ?? []), ...(options.secretValues ?? [])].filter((value): value is string => typeof value === "string" && value.length > 0);
  return Object.freeze([...new Set(values)].sort((left, right) => right.length - left.length));
}

function redactString(value: string, secrets: readonly string[]): string {
  return secrets.reduce((current, secret) => current.split(secret).join(REDACTED), value);
}

function sanitizeValue(value: unknown, secrets: readonly string[], seen: Set<object>, depth: number, maxDepth: number, key?: string): unknown {
  if (key !== undefined && sensitiveKey(key)) return REDACTED;
  if (depth > maxDepth) return "[TRUNCATED]";
  if (value === null) return null;
  if (typeof value === "string") return redactString(value, secrets);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "undefined") return "[UNDEFINED]";
  if (typeof value === "bigint") return `[BIGINT:${value.toString()}]`;
  if (typeof value === "symbol" || typeof value === "function") return "[UNSUPPORTED]";
  if (value instanceof Uint8Array) return "[BINARY_REDACTED]";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[INVALID_DATE]" : value.toISOString();
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  let result: unknown;
  if (value instanceof Error) {
    result = {
      name: redactString(value.name, secrets),
      message: redactString(value.message, secrets),
      ...Object.fromEntries(Object.keys(value).map((property) => [property, sanitizeValue((value as unknown as Record<string, unknown>)[property], secrets, seen, depth + 1, maxDepth, property)]))
    };
  } else if (value instanceof Map || value instanceof Set) {
    result = "[UNSUPPORTED_COLLECTION]";
  } else {
    const output: Record<string, unknown> = {};
    for (const property of Object.keys(value as Record<string, unknown>)) Object.defineProperty(output, property, {
      value: sanitizeValue((value as Record<string, unknown>)[property], secrets, seen, depth + 1, maxDepth, property),
      enumerable: true,
      configurable: true,
      writable: true
    });
    result = output;
  }
  seen.delete(value);
  return result;
}

/** Redacts sensitive field names and caller-supplied secret values without mutating the input. */
export function sanitizeSecrets<T = unknown>(value: T, options: SecretSanitizerOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 8;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) configuration("secret sanitizer maxDepth is invalid");
  return sanitizeValue(value, secretList(options), new Set<object>(), 0, maxDepth);
}

export type AuditOutcome = "allow" | "deny" | "allowed" | "denied" | "success" | "failure";

export interface AuditEventInput {
  readonly tenantId: string;
  readonly subjectId?: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly eventId?: string;
  readonly occurredAt?: string;
  readonly data?: unknown;
  readonly details?: unknown;
}

export interface AuditEntry {
  readonly format: typeof AUDIT_LOG_FORMAT;
  readonly version: typeof AUDIT_LOG_VERSION;
  readonly sequence: number;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly tenantId: string;
  readonly subjectId?: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly data: unknown;
  readonly previousHash: string;
  readonly hash: string;
}

export interface AuditLogOptions {
  readonly now?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly secrets?: readonly string[];
  readonly secretValues?: readonly string[];
}

function unsignedAuditEntry(entry: Omit<AuditEntry, "hash">): Omit<AuditEntry, "hash"> {
  return entry;
}

function auditHash(entry: Omit<AuditEntry, "hash">): string {
  return digest(canonicalize(unsignedAuditEntry(entry)));
}

export function verifyAuditChain(entries: readonly AuditEntry[]): boolean {
  if (!Array.isArray(entries)) return false;
  let previousHash: string = AUDIT_GENESIS_HASH;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.format !== AUDIT_LOG_FORMAT || entry.version !== AUDIT_LOG_VERSION || entry.sequence !== index + 1 || entry.previousHash !== previousHash || typeof entry.hash !== "string") return false;
    try {
      const { hash: _hash, ...withoutHash } = entry;
      if (auditHash(withoutHash) !== entry.hash) return false;
    } catch {
      return false;
    }
    previousHash = entry.hash;
  }
  return true;
}

function freezeDeep(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

// ponytail: append-only in-memory log; use a transactional durable/WORM sink for production retention.
export class AuditLog {
  #records: AuditEntry[] = [];
  #now: () => string;
  #eventIdGenerator: () => string;
  #sanitizerOptions: SecretSanitizerOptions;

  constructor(options: AuditLogOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#eventIdGenerator = options.eventIdGenerator ?? randomUUID;
    this.#sanitizerOptions = {
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.secretValues === undefined ? {} : { secretValues: options.secretValues })
    };
  }

  append(input: AuditEventInput): AuditEntry {
    if (!isRecord(input)) invalid("audit event is invalid");
    if (!verifyAuditChain(this.#records)) throw new SecurityError("AUDIT_INTEGRITY_ERROR", "Audit log integrity check failed");
    const tenantId = identifier(input.tenantId, "tenantId");
    const subjectId = input.subjectId === undefined ? undefined : identifier(input.subjectId, "subjectId");
    const action = identifier(input.action, "action");
    if (!["allow", "deny", "allowed", "denied", "success", "failure"].includes(input.outcome)) invalid("audit outcome is invalid");
    const eventId = identifier(input.eventId ?? this.#eventIdGenerator(), "eventId");
    if (this.#records.some((entry) => entry.eventId === eventId)) invalid("audit eventId must be unique");
    const occurredAt = input.occurredAt ?? this.#now();
    printable(occurredAt, "occurredAt", 128);
    const sourceData = input.data !== undefined ? input.data : input.details !== undefined ? input.details : null;
    const data = freezeDeep(sanitizeSecrets(sourceData, this.#sanitizerOptions));
    const sequence = this.#records.length + 1;
    const unsigned: Omit<AuditEntry, "hash"> = {
      format: AUDIT_LOG_FORMAT,
      version: AUDIT_LOG_VERSION,
      sequence,
      eventId,
      occurredAt,
      tenantId,
      ...(subjectId === undefined ? {} : { subjectId }),
      action,
      outcome: input.outcome,
      data,
      previousHash: this.#records.at(-1)?.hash ?? AUDIT_GENESIS_HASH
    };
    const entry = Object.freeze({ ...unsigned, hash: auditHash(unsigned) });
    this.#records.push(entry);
    return entry;
  }

  entries(): readonly AuditEntry[] {
    return Object.freeze([...this.#records]);
  }

  verify(): boolean {
    return verifyAuditChain(this.#records);
  }
}

export * from "./external-key-provider.js";
export * from "./audit-sink.js";
