import { validateMemoryEnvelope } from "./index.js";
import type { MemoryEnvelope, ValidatorReference, VersionReference } from "./index.js";

export const SPEC_VERSION_V2 = "premise/2" as const;
export type SpecVersionV2 = typeof SPEC_VERSION_V2;
export type Sha256Digest = `sha256:${string}`;
export type V2MemoryStatus = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";
export type V2ValidityPolicy = "IMMUTABLE" | "VERSIONED" | "TTL" | "MANUAL";

export interface V2Validity {
  readonly status: V2MemoryStatus;
  readonly checkedAt: string;
  readonly policy: V2ValidityPolicy;
  readonly expiresAt?: string;
}

export interface ConfidenceDeclaration {
  /** A calibrated score in [0, 1], or null when v1 supplied no score. */
  readonly score: number | null;
  readonly method: string;
  readonly assessedAt?: string;
  readonly rationale?: string;
}

export interface EvidenceReference {
  readonly evidenceId: string;
  readonly sourceUri: string;
  readonly observedAt: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly version?: VersionReference;
  readonly validator?: ValidatorReference;
  readonly confidence?: ConfidenceDeclaration;
  readonly kind?: string;
}

export interface TemporalDeclaration {
  readonly asOf: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
}

export type ConflictStatus = "OPEN" | "RESOLVED";
export type ConflictResolutionStrategy = "MANUAL" | "PREFER_CONFIDENCE" | "PREFER_NEWEST" | "MERGE";

export interface ConflictResolution {
  readonly strategy: ConflictResolutionStrategy;
  readonly resolvedAt: string;
  readonly selectedEvidenceId?: string;
  readonly note?: string;
}

export interface EvidenceConflict {
  readonly conflictId: string;
  readonly evidenceIds: readonly [string, string, ...string[]];
  readonly status: ConflictStatus;
  readonly resolution?: ConflictResolution;
}

export interface DeclaredSignature {
  readonly signatureId: string;
  readonly signerId: string;
  readonly keyId: string;
  readonly algorithm: "ed25519";
  readonly value: string;
  readonly signedAt: string;
  readonly evidenceId?: string;
}

export interface MemoryEnvelopeV2 {
  readonly specVersion: SpecVersionV2;
  /** All memory and dependency identifiers are scoped by this tenant. */
  readonly tenantId: string;
  readonly memoryId: string;
  readonly contentDigest?: Sha256Digest;
  readonly evidence: readonly EvidenceReference[];
  readonly confidence: ConfidenceDeclaration;
  readonly conflicts: readonly EvidenceConflict[];
  readonly temporal: TemporalDeclaration;
  readonly validity: V2Validity;
  readonly dependsOn: readonly string[];
  /** Detached Ed25519 signature declarations verified by `verifyMemoryEnvelopeV2Signatures`. */
  readonly signatures: readonly DeclaredSignature[];
}

export type V2OperationName = "register" | "derive" | "replace" | "signal" | "validate" | "migrate";

export interface V2OperationRequest<TPayload = Readonly<Record<string, unknown>>> {
  readonly specVersion: SpecVersionV2;
  readonly tenantId: string;
  readonly operationId: string;
  readonly operation: V2OperationName;
  readonly idempotencyKey: string;
  readonly requestDigest: Sha256Digest;
  readonly requestedAt: string;
  readonly payload: TPayload;
}

export type IdempotencyDecision = "NEW" | "REPLAY" | "CONFLICT";

export type V2EventType =
  | "MemoryRegistered"
  | "MemoryDerived"
  | "SourceChanged"
  | "MemoryStaled"
  | "MemoryInvalidated"
  | "MemoryRevalidated"
  | "MemoryReplaced"
  | "ConflictDetected"
  | "ConflictResolved"
  | "MemoryMigrated";

export interface V2Event {
  readonly specVersion: SpecVersionV2;
  readonly tenantId: string;
  readonly eventId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: Sha256Digest;
  readonly type: V2EventType;
  readonly occurredAt: string;
  readonly memoryId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type V2StreamEventKind = "SNAPSHOT" | "DELTA";
export type V2StreamCapability = "ORDERED_EVENTS" | "AUTHORITATIVE_SNAPSHOT" | "DELTA_EVENTS" | "DUPLICATE_SAFE";

/** Additive envelope for an ordered source stream; V2Event remains compatible. */
export interface V2StreamEvent extends V2Event {
  readonly streamId: string;
  readonly sequence: number;
  readonly kind: V2StreamEventKind;
  readonly cursor?: string;
  readonly sourceVersion?: VersionReference;
}

export interface V2EventStreamPage {
  readonly specVersion: SpecVersionV2;
  readonly tenantId: string;
  readonly streamId: string;
  readonly events: readonly V2StreamEvent[];
  readonly headSequence: number;
  readonly nextCursor?: string;
}

export interface V2ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class V2EnvelopeValidationError extends Error {
  readonly issues: readonly V2ValidationIssue[];

  constructor(issues: readonly V2ValidationIssue[]) {
    super(`Invalid PREMiSE v2 contract (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "V2EnvelopeValidationError";
    this.issues = issues;
  }
}

const statuses = new Set<V2MemoryStatus>(["FRESH", "STALE", "INVALID", "UNKNOWN"]);
const policies = new Set<V2ValidityPolicy>(["IMMUTABLE", "VERSIONED", "TTL", "MANUAL"]);
const conflictStatuses = new Set<ConflictStatus>(["OPEN", "RESOLVED"]);
const resolutionStrategies = new Set<ConflictResolutionStrategy>(["MANUAL", "PREFER_CONFIDENCE", "PREFER_NEWEST", "MERGE"]);
const operations = new Set<V2OperationName>(["register", "derive", "replace", "signal", "validate", "migrate"]);
const eventTypes = new Set<V2EventType>([
  "MemoryRegistered",
  "MemoryDerived",
  "SourceChanged",
  "MemoryStaled",
  "MemoryInvalidated",
  "MemoryRevalidated",
  "MemoryReplaced",
  "ConflictDetected",
  "ConflictResolved",
  "MemoryMigrated"
]);
const eventsWithMemory = new Set<V2EventType>([
  "MemoryRegistered",
  "MemoryDerived",
  "MemoryStaled",
  "MemoryInvalidated",
  "MemoryRevalidated",
  "MemoryReplaced",
  "ConflictDetected",
  "ConflictResolved",
  "MemoryMigrated"
]);
const streamEventKinds = new Set<V2StreamEventKind>(["SNAPSHOT", "DELTA"]);
const streamCapabilities = new Set<V2StreamCapability>(["ORDERED_EVENTS", "AUTHORITATIVE_SNAPSHOT", "DELTA_EVENTS", "DUPLICATE_SAFE"]);

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(value: AnyRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTenantId(value: unknown): value is string {
  return isNonEmptyString(value) && value === value.trim();
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:.+$/.test(value);
}

function add(issues: V2ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function rejectUnknown(value: AnyRecord, path: string, allowed: ReadonlySet<string>, issues: V2ValidationIssue[]): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) add(issues, `${path}.${key}`, "is not a permitted field");
}

function validateVersion(value: unknown, path: string, issues: V2ValidationIssue[]): value is VersionReference {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  rejectUnknown(value, path, new Set(["scheme", "token"]), issues);
  if (!isNonEmptyString(value.scheme)) add(issues, `${path}.scheme`, "must be a non-empty string");
  if (!isNonEmptyString(value.token)) add(issues, `${path}.token`, "must be a non-empty string");
  return true;
}

function validateValidator(value: unknown, path: string, issues: V2ValidationIssue[]): value is ValidatorReference {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  rejectUnknown(value, path, new Set(["id", "operation"]), issues);
  if (!isNonEmptyString(value.id)) add(issues, `${path}.id`, "must be a non-empty string");
  if (!isNonEmptyString(value.operation)) add(issues, `${path}.operation`, "must be a non-empty string");
  return true;
}

function validateConfidence(value: unknown, path: string, issues: V2ValidationIssue[]): value is ConfidenceDeclaration {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  rejectUnknown(value, path, new Set(["score", "method", "assessedAt", "rationale"]), issues);
  if (!has(value, "score") || (value.score !== null && (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 1))) add(issues, `${path}.score`, "must be null or a finite number between 0 and 1");
  if (!isNonEmptyString(value.method)) add(issues, `${path}.method`, "must be a non-empty string");
  if (has(value, "assessedAt") && !isDateTime(value.assessedAt)) add(issues, `${path}.assessedAt`, "must be an ISO date-time string");
  if (has(value, "rationale") && !isNonEmptyString(value.rationale)) add(issues, `${path}.rationale`, "must be a non-empty string");
  return true;
}

function validateWindow(value: AnyRecord, path: string, issues: V2ValidationIssue[]): void {
  const validFrom = isDateTime(value.validFrom) ? value.validFrom : undefined;
  const validUntil = isDateTime(value.validUntil) ? value.validUntil : undefined;
  if (has(value, "validFrom") && !validFrom) add(issues, `${path}.validFrom`, "must be an ISO date-time string");
  if (has(value, "validUntil") && !validUntil) add(issues, `${path}.validUntil`, "must be an ISO date-time string");
  if (validFrom && validUntil && Date.parse(validFrom) >= Date.parse(validUntil)) add(issues, path, "validFrom must be before validUntil");
}

function validateEvidence(value: unknown, path: string, issues: V2ValidationIssue[]): value is EvidenceReference {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  rejectUnknown(value, path, new Set(["evidenceId", "sourceUri", "observedAt", "validFrom", "validUntil", "version", "validator", "confidence", "kind"]), issues);
  if (!isNonEmptyString(value.evidenceId)) add(issues, `${path}.evidenceId`, "must be a non-empty string");
  if (!isNonEmptyString(value.sourceUri)) add(issues, `${path}.sourceUri`, "must be a non-empty string");
  if (!isDateTime(value.observedAt)) add(issues, `${path}.observedAt`, "must be an ISO date-time string");
  validateWindow(value, path, issues);
  const hasVersion = has(value, "version");
  const hasValidator = has(value, "validator");
  if (hasVersion !== hasValidator) add(issues, path, "version and validator must appear together");
  if (hasVersion) validateVersion(value.version, `${path}.version`, issues);
  if (hasValidator) validateValidator(value.validator, `${path}.validator`, issues);
  if (has(value, "confidence")) validateConfidence(value.confidence, `${path}.confidence`, issues);
  if (has(value, "kind") && !isNonEmptyString(value.kind)) add(issues, `${path}.kind`, "must be a non-empty string");
  return true;
}

function validateTemporal(value: unknown, path: string, issues: V2ValidationIssue[]): value is TemporalDeclaration {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  rejectUnknown(value, path, new Set(["asOf", "validFrom", "validUntil"]), issues);
  if (!isDateTime(value.asOf)) add(issues, `${path}.asOf`, "must be an ISO date-time string");
  validateWindow(value, path, issues);
  return true;
}

function validateValidity(value: unknown, path: string, issues: V2ValidationIssue[]): value is V2Validity {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  rejectUnknown(value, path, new Set(["status", "checkedAt", "policy", "expiresAt"]), issues);
  if (typeof value.status !== "string" || !statuses.has(value.status as V2MemoryStatus)) add(issues, `${path}.status`, "must be a PREMiSE v2 memory status");
  if (!isDateTime(value.checkedAt)) add(issues, `${path}.checkedAt`, "must be an ISO date-time string");
  if (typeof value.policy !== "string" || !policies.has(value.policy as V2ValidityPolicy)) add(issues, `${path}.policy`, "must be a PREMiSE validity policy");
  if (value.policy === "TTL" && !isDateTime(value.expiresAt)) add(issues, `${path}.expiresAt`, "is required for TTL policy and must be an ISO date-time string");
  if (value.policy !== "TTL" && has(value, "expiresAt")) add(issues, `${path}.expiresAt`, "is only allowed for TTL policy");
  return true;
}

function validateResolution(value: unknown, path: string, conflictEvidenceIds: ReadonlySet<string>, issues: V2ValidationIssue[]): value is ConflictResolution {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  rejectUnknown(value, path, new Set(["strategy", "resolvedAt", "selectedEvidenceId", "note"]), issues);
  if (typeof value.strategy !== "string" || !resolutionStrategies.has(value.strategy as ConflictResolutionStrategy)) add(issues, `${path}.strategy`, "must be a supported conflict resolution strategy");
  if (!isDateTime(value.resolvedAt)) add(issues, `${path}.resolvedAt`, "must be an ISO date-time string");
  if (has(value, "selectedEvidenceId")) {
    if (!isNonEmptyString(value.selectedEvidenceId)) add(issues, `${path}.selectedEvidenceId`, "must be a non-empty string");
    else if (!conflictEvidenceIds.has(value.selectedEvidenceId)) add(issues, `${path}.selectedEvidenceId`, "must reference evidence in the conflict");
  }
  if (has(value, "note") && !isNonEmptyString(value.note)) add(issues, `${path}.note`, "must be a non-empty string");
  return true;
}

function validateConflict(value: unknown, path: string, evidenceIds: ReadonlySet<string>, issues: V2ValidationIssue[]): value is EvidenceConflict {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  rejectUnknown(value, path, new Set(["conflictId", "evidenceIds", "status", "resolution"]), issues);
  if (!isNonEmptyString(value.conflictId)) add(issues, `${path}.conflictId`, "must be a non-empty string");
  let conflictEvidenceIds = new Set<string>();
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length < 2 || value.evidenceIds.some((id) => !isNonEmptyString(id))) add(issues, `${path}.evidenceIds`, "must contain at least two non-empty evidence ids");
  else {
    conflictEvidenceIds = new Set(value.evidenceIds);
    if (conflictEvidenceIds.size !== value.evidenceIds.length) add(issues, `${path}.evidenceIds`, "must not contain duplicate evidence ids");
    for (const evidenceId of value.evidenceIds) if (!evidenceIds.has(evidenceId)) add(issues, `${path}.evidenceIds`, `references unknown evidence ${evidenceId}`);
  }
  if (typeof value.status !== "string" || !conflictStatuses.has(value.status as ConflictStatus)) add(issues, `${path}.status`, "must be OPEN or RESOLVED");
  if (value.status === "OPEN" && has(value, "resolution")) add(issues, `${path}.resolution`, "is not allowed for an OPEN conflict");
  if (value.status === "RESOLVED" && !has(value, "resolution")) add(issues, `${path}.resolution`, "is required for a RESOLVED conflict");
  if (has(value, "resolution")) validateResolution(value.resolution, `${path}.resolution`, conflictEvidenceIds, issues);
  return true;
}

function validateSignature(value: unknown, path: string, evidenceIds: ReadonlySet<string>, issues: V2ValidationIssue[]): value is DeclaredSignature {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  rejectUnknown(value, path, new Set(["signatureId", "signerId", "keyId", "algorithm", "value", "signedAt", "evidenceId"]), issues);
  for (const field of ["signatureId", "signerId", "keyId", "value"] as const) if (!isNonEmptyString(value[field])) add(issues, `${path}.${field}`, "must be a non-empty string");
  if (value.algorithm !== "ed25519") add(issues, `${path}.algorithm`, "must equal ed25519");
  if (!isDateTime(value.signedAt)) add(issues, `${path}.signedAt`, "must be an ISO date-time string");
  if (has(value, "evidenceId")) {
    if (!isNonEmptyString(value.evidenceId)) add(issues, `${path}.evidenceId`, "must be a non-empty string");
    else if (!evidenceIds.has(value.evidenceId)) add(issues, `${path}.evidenceId`, "must reference evidence in this envelope");
  }
  return true;
}

export function validateMemoryEnvelopeV2(input: unknown): V2ValidationIssue[] {
  const issues: V2ValidationIssue[] = [];
  if (!isRecord(input)) return [{ path: "$", message: "must be an object" }];
  rejectUnknown(input, "$", new Set(["specVersion", "tenantId", "memoryId", "contentDigest", "evidence", "confidence", "conflicts", "temporal", "validity", "dependsOn", "signatures"]), issues);
  if (input.specVersion !== SPEC_VERSION_V2) add(issues, "$.specVersion", `must equal ${SPEC_VERSION_V2}`);
  if (!isTenantId(input.tenantId)) add(issues, "$.tenantId", "must be a non-empty tenant id without surrounding whitespace");
  if (!isNonEmptyString(input.memoryId)) add(issues, "$.memoryId", "must be a non-empty string");
  if (has(input, "contentDigest") && !isDigest(input.contentDigest)) add(issues, "$.contentDigest", "must use the sha256: digest prefix and a non-empty digest");

  const evidenceIds = new Set<string>();
  let evidenceCount = 0;
  if (!Array.isArray(input.evidence)) add(issues, "$.evidence", "must be an array");
  else {
    evidenceCount = input.evidence.length;
    input.evidence.forEach((evidence, index) => {
      validateEvidence(evidence, `$.evidence[${index}]`, issues);
      if (isRecord(evidence) && isNonEmptyString(evidence.evidenceId)) {
        if (evidenceIds.has(evidence.evidenceId)) add(issues, `$.evidence[${index}].evidenceId`, "must be unique in the envelope");
        evidenceIds.add(evidence.evidenceId);
      }
    });
  }

  validateConfidence(input.confidence, "$.confidence", issues);

  let openConflict = false;
  const conflictIds = new Set<string>();
  if (!Array.isArray(input.conflicts)) add(issues, "$.conflicts", "must be an array");
  else input.conflicts.forEach((conflict, index) => {
    validateConflict(conflict, `$.conflicts[${index}]`, evidenceIds, issues);
    if (isRecord(conflict)) {
      if (conflict.status === "OPEN") openConflict = true;
      if (isNonEmptyString(conflict.conflictId)) {
        if (conflictIds.has(conflict.conflictId)) add(issues, `$.conflicts[${index}].conflictId`, "must be unique in the envelope");
        conflictIds.add(conflict.conflictId);
      }
    }
  });

  validateTemporal(input.temporal, "$.temporal", issues);
  validateValidity(input.validity, "$.validity", issues);
  if (openConflict && isRecord(input.validity) && input.validity.status === "FRESH") add(issues, "$.validity.status", "cannot be FRESH while a conflict is OPEN");

  let dependencyCount = 0;
  if (!Array.isArray(input.dependsOn) || input.dependsOn.some((id) => !isNonEmptyString(id))) add(issues, "$.dependsOn", "must be an array of non-empty memory ids");
  else {
    dependencyCount = input.dependsOn.length;
    if (new Set(input.dependsOn).size !== input.dependsOn.length) add(issues, "$.dependsOn", "must not contain duplicate memory ids");
  }
  if (evidenceCount === 0 && dependencyCount === 0) add(issues, "$", "must contain evidence or at least one dependency");

  const signatureIds = new Set<string>();
  if (!Array.isArray(input.signatures)) add(issues, "$.signatures", "must be an array");
  else input.signatures.forEach((signature, index) => {
    validateSignature(signature, `$.signatures[${index}]`, evidenceIds, issues);
    if (isRecord(signature) && isNonEmptyString(signature.signatureId)) {
      if (signatureIds.has(signature.signatureId)) add(issues, `$.signatures[${index}].signatureId`, "must be unique in the envelope");
      signatureIds.add(signature.signatureId);
    }
  });
  return issues;
}

export function isMemoryEnvelopeV2(input: unknown): input is MemoryEnvelopeV2 {
  return validateMemoryEnvelopeV2(input).length === 0;
}

export function parseMemoryEnvelopeV2(input: unknown): MemoryEnvelopeV2 {
  const issues = validateMemoryEnvelopeV2(input);
  if (issues.length > 0) throw new V2EnvelopeValidationError(issues);
  return input as MemoryEnvelopeV2;
}

export function validateV2OperationRequest(input: unknown): V2ValidationIssue[] {
  const issues: V2ValidationIssue[] = [];
  if (!isRecord(input)) return [{ path: "$", message: "must be an object" }];
  rejectUnknown(input, "$", new Set(["specVersion", "tenantId", "operationId", "operation", "idempotencyKey", "requestDigest", "requestedAt", "payload"]), issues);
  if (input.specVersion !== SPEC_VERSION_V2) add(issues, "$.specVersion", `must equal ${SPEC_VERSION_V2}`);
  if (!isTenantId(input.tenantId)) add(issues, "$.tenantId", "must be a non-empty tenant id without surrounding whitespace");
  if (!isNonEmptyString(input.operationId)) add(issues, "$.operationId", "must be a non-empty string");
  if (typeof input.operation !== "string" || !operations.has(input.operation as V2OperationName)) add(issues, "$.operation", "must be a supported v2 operation");
  if (!isNonEmptyString(input.idempotencyKey)) add(issues, "$.idempotencyKey", "must be a non-empty string");
  if (!isDigest(input.requestDigest)) add(issues, "$.requestDigest", "must use the sha256: digest prefix and a non-empty digest");
  if (!isDateTime(input.requestedAt)) add(issues, "$.requestedAt", "must be an ISO date-time string");
  if (!isRecord(input.payload)) add(issues, "$.payload", "must be an object");
  return issues;
}

export function isV2OperationRequest(input: unknown): input is V2OperationRequest {
  return validateV2OperationRequest(input).length === 0;
}

export function parseV2OperationRequest<TPayload = Readonly<Record<string, unknown>>>(input: unknown): V2OperationRequest<TPayload> {
  const issues = validateV2OperationRequest(input);
  if (issues.length > 0) throw new V2EnvelopeValidationError(issues);
  return input as V2OperationRequest<TPayload>;
}

export function classifyIdempotency(
  incoming: Pick<V2OperationRequest, "tenantId" | "operation" | "idempotencyKey" | "requestDigest">,
  existing?: Pick<V2OperationRequest, "tenantId" | "operation" | "idempotencyKey" | "requestDigest">
): IdempotencyDecision {
  if (!existing) return "NEW";
  if (incoming.tenantId !== existing.tenantId || incoming.operation !== existing.operation || incoming.idempotencyKey !== existing.idempotencyKey) return "NEW";
  return incoming.requestDigest === existing.requestDigest ? "REPLAY" : "CONFLICT";
}

export function validateV2Event(input: unknown): V2ValidationIssue[] {
  const issues: V2ValidationIssue[] = [];
  if (!isRecord(input)) return [{ path: "$", message: "must be an object" }];
  rejectUnknown(input, "$", new Set(["specVersion", "tenantId", "eventId", "operationId", "idempotencyKey", "requestDigest", "type", "occurredAt", "memoryId", "payload"]), issues);
  if (input.specVersion !== SPEC_VERSION_V2) add(issues, "$.specVersion", `must equal ${SPEC_VERSION_V2}`);
  if (!isTenantId(input.tenantId)) add(issues, "$.tenantId", "must be a non-empty tenant id without surrounding whitespace");
  if (!isNonEmptyString(input.eventId)) add(issues, "$.eventId", "must be a non-empty string");
  if (!isNonEmptyString(input.operationId)) add(issues, "$.operationId", "must be a non-empty string");
  if (!isNonEmptyString(input.idempotencyKey)) add(issues, "$.idempotencyKey", "must be a non-empty string");
  if (!isDigest(input.requestDigest)) add(issues, "$.requestDigest", "must use the sha256: digest prefix and a non-empty digest");
  if (typeof input.type !== "string" || !eventTypes.has(input.type as V2EventType)) add(issues, "$.type", "must be a supported v2 event type");
  if (!isDateTime(input.occurredAt)) add(issues, "$.occurredAt", "must be an ISO date-time string");
  if (has(input, "memoryId") && !isNonEmptyString(input.memoryId)) add(issues, "$.memoryId", "must be a non-empty string when present");
  if (typeof input.type === "string" && eventsWithMemory.has(input.type as V2EventType) && !isNonEmptyString(input.memoryId)) add(issues, "$.memoryId", "is required for this event type");
  if (!isRecord(input.payload)) add(issues, "$.payload", "must be an object");
  return issues;
}

export function isV2Event(input: unknown): input is V2Event {
  return validateV2Event(input).length === 0;
}

export function parseV2Event(input: unknown): V2Event {
  const issues = validateV2Event(input);
  if (issues.length > 0) throw new V2EnvelopeValidationError(issues);
  return input as V2Event;
}

export function validateV2StreamEvent(input: unknown): V2ValidationIssue[] {
  const issues: V2ValidationIssue[] = [];
  if (!isRecord(input)) return [{ path: "$", message: "must be an object" }];
  rejectUnknown(input, "$", new Set(["specVersion", "tenantId", "eventId", "operationId", "idempotencyKey", "requestDigest", "type", "occurredAt", "memoryId", "payload", "streamId", "sequence", "kind", "cursor", "sourceVersion"]), issues);
  const base: AnyRecord = { ...input };
  delete base.streamId;
  delete base.sequence;
  delete base.kind;
  delete base.cursor;
  delete base.sourceVersion;
  issues.push(...validateV2Event(base));
  if (!isNonEmptyString(input.streamId)) add(issues, "$.streamId", "must be a non-empty string");
  if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 0) add(issues, "$.sequence", "must be a non-negative safe integer");
  if (typeof input.kind !== "string" || !streamEventKinds.has(input.kind as V2StreamEventKind)) add(issues, "$.kind", "must be SNAPSHOT or DELTA");
  if (has(input, "cursor") && !isNonEmptyString(input.cursor)) add(issues, "$.cursor", "must be a non-empty string when present");
  if (has(input, "sourceVersion")) validateVersion(input.sourceVersion, "$.sourceVersion", issues);
  return issues;
}

export function isV2StreamEvent(input: unknown): input is V2StreamEvent {
  return validateV2StreamEvent(input).length === 0;
}

export function parseV2StreamEvent(input: unknown): V2StreamEvent {
  const issues = validateV2StreamEvent(input);
  if (issues.length > 0) throw new V2EnvelopeValidationError(issues);
  return input as V2StreamEvent;
}

export function validateV2EventStreamPage(input: unknown): V2ValidationIssue[] {
  const issues: V2ValidationIssue[] = [];
  if (!isRecord(input)) return [{ path: "$", message: "must be an object" }];
  rejectUnknown(input, "$", new Set(["specVersion", "tenantId", "streamId", "events", "headSequence", "nextCursor"]), issues);
  if (input.specVersion !== SPEC_VERSION_V2) add(issues, "$.specVersion", `must equal ${SPEC_VERSION_V2}`);
  if (!isTenantId(input.tenantId)) add(issues, "$.tenantId", "must be a non-empty tenant id without surrounding whitespace");
  if (!isNonEmptyString(input.streamId)) add(issues, "$.streamId", "must be a non-empty string");
  if (!Array.isArray(input.events)) add(issues, "$.events", "must be an array");
  else input.events.forEach((event, index) => {
    const eventIssues = validateV2StreamEvent(event);
    for (const issue of eventIssues) issues.push({ path: `$.events[${index}]${issue.path === "$" ? "" : issue.path.slice(1)}`, message: issue.message });
    if (isRecord(event) && event.streamId !== input.streamId) add(issues, `$.events[${index}].streamId`, "must match page.streamId");
    if (isRecord(event) && event.tenantId !== input.tenantId) add(issues, `$.events[${index}].tenantId`, "must match page.tenantId");
  });
  if (!Number.isSafeInteger(input.headSequence) || (input.headSequence as number) < 0) add(issues, "$.headSequence", "must be a non-negative safe integer");
  if (has(input, "nextCursor") && !isNonEmptyString(input.nextCursor)) add(issues, "$.nextCursor", "must be a non-empty string when present");
  if (Array.isArray(input.events) && Number.isSafeInteger(input.headSequence) && input.events.some((event) => isRecord(event) && Number.isSafeInteger(event.sequence) && (event.sequence as number) > (input.headSequence as number))) {
    add(issues, "$.headSequence", "must be at least the greatest event sequence");
  }
  return issues;
}

export function isV2EventStreamPage(input: unknown): input is V2EventStreamPage {
  return validateV2EventStreamPage(input).length === 0;
}

export function parseV2EventStreamPage(input: unknown): V2EventStreamPage {
  const issues = validateV2EventStreamPage(input);
  if (issues.length > 0) throw new V2EnvelopeValidationError(issues);
  return input as V2EventStreamPage;
}

export function isV2StreamCapability(value: unknown): value is V2StreamCapability {
  return typeof value === "string" && streamCapabilities.has(value as V2StreamCapability);
}

export interface V1MigrationOptions {
  readonly tenantId: string;
  readonly migratedAt?: string;
}

export function migrateV1Envelope(input: unknown, options: V1MigrationOptions): MemoryEnvelopeV2 {
  const migrationIssues: V2ValidationIssue[] = [];
  if (!isTenantId(options?.tenantId)) add(migrationIssues, "$.options.tenantId", "is required and must be a non-empty tenant id without surrounding whitespace");
  if (options?.migratedAt !== undefined && !isDateTime(options.migratedAt)) add(migrationIssues, "$.options.migratedAt", "must be an ISO date-time string");
  if (migrationIssues.length > 0) throw new V2EnvelopeValidationError(migrationIssues);

  const v1Issues = validateMemoryEnvelope(input);
  if (v1Issues.length > 0) {
    throw new V2EnvelopeValidationError(v1Issues.map(({ path, message }) => ({
      path: path === "$" ? "$.v1" : `$.v1${path.slice(1)}`,
      message: `invalid v1 envelope: ${message}`
    })));
  }

  const v1 = input as MemoryEnvelope;
  const migratedAt = options.migratedAt ?? v1.validity.checkedAt;
  const evidence: EvidenceReference[] = (v1.provenance ?? []).map((source, index) => {
    return {
      evidenceId: `v1:${index + 1}`,
      sourceUri: source.sourceUri,
      observedAt: source.observedAt,
      ...(source.version !== undefined && source.validator !== undefined ? { version: source.version, validator: source.validator } : {})
    };
  });
  const validity: V2Validity = {
    status: v1.validity.status,
    checkedAt: v1.validity.checkedAt,
    policy: v1.validity.policy,
    ...(v1.validity.expiresAt !== undefined ? { expiresAt: v1.validity.expiresAt } : {})
  };
  const migrated: MemoryEnvelopeV2 = {
    specVersion: SPEC_VERSION_V2,
    tenantId: options.tenantId,
    memoryId: v1.memoryId,
    ...(v1.contentDigest !== undefined ? { contentDigest: v1.contentDigest } : {}),
    evidence,
    confidence: { score: null, method: "v1-migration", assessedAt: migratedAt },
    conflicts: [],
    temporal: {
      asOf: migratedAt,
      ...(v1.validity.expiresAt !== undefined ? { validUntil: v1.validity.expiresAt } : {})
    },
    validity,
    dependsOn: [...v1.dependsOn],
    signatures: []
  };
  const issues = validateMemoryEnvelopeV2(migrated);
  if (issues.length > 0) throw new V2EnvelopeValidationError(issues);
  return migrated;
}
