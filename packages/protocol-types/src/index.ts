export const SPEC_VERSION = "premise/0.1" as const;

export type SpecVersion = typeof SPEC_VERSION;
export type MemoryStatus = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";
export type ValidityPolicy = "IMMUTABLE" | "VERSIONED" | "TTL" | "MANUAL";
export type ValidatorResult = "UNCHANGED" | "CHANGED" | "MISSING" | "UNKNOWN";
export type UsabilityDecision = "USABLE" | "REVALIDATE" | "REJECT";
export type Capability = "RECORD" | "DEPENDENCY" | "REVALIDATION" | "RETRIEVAL" | "GATE";
export type CompatibilityProfile = "PREMiSE-compatible v0.1";

export interface VersionReference {
  readonly scheme: string;
  readonly token: string;
}

export interface ValidatorReference {
  readonly id: string;
  readonly operation: string;
}

export interface SourceReference {
  readonly sourceUri: string;
  readonly observedAt: string;
  readonly version?: VersionReference;
  readonly validator?: ValidatorReference;
}

export interface Validity {
  readonly status: MemoryStatus;
  readonly checkedAt: string;
  readonly policy: ValidityPolicy;
  readonly expiresAt?: string;
}

export interface MemoryEnvelope {
  readonly specVersion: SpecVersion;
  readonly memoryId: string;
  readonly contentDigest?: `sha256:${string}`;
  readonly provenance?: readonly SourceReference[];
  readonly validity: Validity;
  readonly dependsOn: readonly string[];
}

export interface DerivedMemoryEnvelope extends MemoryEnvelope {
  readonly dependsOn: readonly [string, ...string[]];
}

export interface ValidationResult {
  readonly memoryId: string;
  readonly result: ValidatorResult;
  readonly checkedAt: string;
  readonly status: MemoryStatus;
  readonly sourceUri?: string;
  readonly version?: VersionReference;
}

export type PremiseEventType =
  | "MemoryRegistered"
  | "MemoryDerived"
  | "SourceChanged"
  | "MemoryStaled"
  | "MemoryInvalidated"
  | "MemoryRevalidated"
  | "MemoryReplaced";

export interface PremiseEventBase {
  readonly specVersion: SpecVersion;
  readonly type: PremiseEventType;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly memoryId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PremiseEvent extends PremiseEventBase {
  readonly dependsOn?: readonly string[];
  readonly sourceUri?: string;
  readonly result?: ValidatorResult;
  readonly previousStatus?: MemoryStatus;
  readonly nextStatus?: MemoryStatus;
  readonly version?: VersionReference;
}

export interface CapabilitiesDeclaration {
  readonly specVersion: SpecVersion;
  readonly capabilities: readonly Capability[];
  readonly profile?: CompatibilityProfile;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class EnvelopeValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(`Invalid PREMiSE memory envelope (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "EnvelopeValidationError";
    this.issues = issues;
  }
}

const statuses = new Set<MemoryStatus>(["FRESH", "STALE", "INVALID", "UNKNOWN"]);
const policies = new Set<ValidityPolicy>(["IMMUTABLE", "VERSIONED", "TTL", "MANUAL"]);
const validatorResults = new Set<ValidatorResult>(["UNCHANGED", "CHANGED", "MISSING", "UNKNOWN"]);
const capabilities = new Set<Capability>(["RECORD", "DEPENDENCY", "REVALIDATION", "RETRIEVAL", "GATE"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

function add(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function validateVersion(value: unknown, path: string, issues: ValidationIssue[]): value is VersionReference {
  if (!isRecord(value) || typeof value.scheme !== "string" || value.scheme.length === 0 || typeof value.token !== "string" || value.token.length === 0) {
    add(issues, path, "must contain non-empty scheme and token strings");
    return false;
  }
  return true;
}

function validateValidator(value: unknown, path: string, issues: ValidationIssue[]): value is ValidatorReference {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.operation !== "string" || value.operation.length === 0) {
    add(issues, path, "must contain non-empty id and operation strings");
    return false;
  }
  return true;
}

function validateSource(value: unknown, path: string, issues: ValidationIssue[]): value is SourceReference {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  if (typeof value.sourceUri !== "string" || value.sourceUri.length === 0) add(issues, `${path}.sourceUri`, "must be a non-empty string");
  if (!isDateTime(value.observedAt)) add(issues, `${path}.observedAt`, "must be an ISO date-time string");
  const hasVersion = has(value, "version");
  const hasValidator = has(value, "validator");
  if (hasVersion !== hasValidator) add(issues, path, "version and validator must appear together");
  if (hasVersion) validateVersion(value.version, `${path}.version`, issues);
  if (hasValidator) validateValidator(value.validator, `${path}.validator`, issues);
  return true;
}

function validateValidity(value: unknown, path: string, issues: ValidationIssue[]): value is Validity {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  if (typeof value.status !== "string" || !statuses.has(value.status as MemoryStatus)) add(issues, `${path}.status`, "must be a PREMiSE memory status");
  if (!isDateTime(value.checkedAt)) add(issues, `${path}.checkedAt`, "must be an ISO date-time string");
  if (typeof value.policy !== "string" || !policies.has(value.policy as ValidityPolicy)) add(issues, `${path}.policy`, "must be a PREMiSE validity policy");
  if (value.policy === "TTL" && !isDateTime(value.expiresAt)) add(issues, `${path}.expiresAt`, "is required for TTL policy and must be an ISO date-time string");
  if (value.policy !== "TTL" && has(value, "expiresAt")) add(issues, `${path}.expiresAt`, "is only allowed for TTL policy");
  return true;
}

export function validateMemoryEnvelope(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return [{ path: "$", message: "must be an object" }];
  const allowed = new Set(["specVersion", "memoryId", "contentDigest", "provenance", "validity", "dependsOn"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) add(issues, `$.${key}`, "is not a permitted envelope field");
  if (input.specVersion !== SPEC_VERSION) add(issues, "$.specVersion", `must equal ${SPEC_VERSION}`);
  if (typeof input.memoryId !== "string" || input.memoryId.length === 0) add(issues, "$.memoryId", "must be a non-empty string");
  if (has(input, "contentDigest") && (typeof input.contentDigest !== "string" || !/^sha256:.+$/.test(input.contentDigest))) add(issues, "$.contentDigest", "must use the sha256: digest prefix and a non-empty digest");
  if (has(input, "provenance")) {
    if (!Array.isArray(input.provenance)) add(issues, "$.provenance", "must be an array");
    else {
      if (input.provenance.length === 0) add(issues, "$.provenance", "must contain at least one source when present");
      input.provenance.forEach((source, index) => {
        const validSource = validateSource(source, `$.provenance[${index}]`, issues);
        if (validSource && input.validity && isRecord(input.validity) && input.validity.policy === "VERSIONED" && (!has(source as unknown as Record<string, unknown>, "version") || !has(source as unknown as Record<string, unknown>, "validator"))) add(issues, `$.provenance[${index}]`, "VERSIONED provenance requires version and validator");
      });
    }
  }
  validateValidity(input.validity, "$.validity", issues);
  if (!Array.isArray(input.dependsOn) || input.dependsOn.some((id) => typeof id !== "string" || id.length === 0)) add(issues, "$.dependsOn", "must be an array of non-empty memory ids");
  else if (new Set(input.dependsOn).size !== input.dependsOn.length) add(issues, "$.dependsOn", "must not contain duplicate memory ids");
  const provenanceCount = Array.isArray(input.provenance) ? input.provenance.length : 0;
  const dependencyCount = Array.isArray(input.dependsOn) ? input.dependsOn.length : 0;
  if (provenanceCount === 0 && dependencyCount === 0) add(issues, "$", "must contain provenance or at least one dependency");
  if (input.validity && isRecord(input.validity) && input.validity.policy === "VERSIONED" && provenanceCount === 0) add(issues, "$.provenance", "is required for VERSIONED policy");
  return issues;
}

export function isMemoryEnvelope(input: unknown): input is MemoryEnvelope {
  return validateMemoryEnvelope(input).length === 0;
}

export function parseMemoryEnvelope(input: unknown): MemoryEnvelope {
  const issues = validateMemoryEnvelope(input);
  if (issues.length > 0) throw new EnvelopeValidationError(issues);
  return input as MemoryEnvelope;
}

export function isValidationResult(input: unknown): input is ValidationResult {
  if (!isRecord(input) || typeof input.memoryId !== "string" || input.memoryId.length === 0 || typeof input.result !== "string" || !validatorResults.has(input.result as ValidatorResult) || !isDateTime(input.checkedAt) || typeof input.status !== "string" || !statuses.has(input.status as MemoryStatus)) return false;
  const expectedStatus: MemoryStatus = input.result === "UNCHANGED" ? "FRESH" : input.result === "CHANGED" || input.result === "MISSING" ? "INVALID" : "UNKNOWN";
  if (input.status !== expectedStatus) return false;
  if (input.result === "UNCHANGED" || input.result === "CHANGED") return validateVersion(input.version, "$.version", []);
  return input.version === undefined;
}

export function isCapabilitiesDeclaration(input: unknown): input is CapabilitiesDeclaration {
  if (!isRecord(input) || input.specVersion !== SPEC_VERSION || !Array.isArray(input.capabilities)) return false;
  const declared = input.capabilities as unknown[];
  if (new Set(declared).size !== declared.length || !declared.every((capability) => typeof capability === "string" && capabilities.has(capability as Capability))) return false;
  if (input.profile !== undefined && input.profile !== "PREMiSE-compatible v0.1") return false;
  return input.profile === undefined || ["RECORD", "DEPENDENCY", "REVALIDATION"].every((required) => declared.includes(required));
}

export function usabilityForStatus(status: MemoryStatus): UsabilityDecision {
  if (status === "FRESH") return "USABLE";
  if (status === "INVALID") return "REJECT";
  return "REVALIDATE";
}

export * from "./v2.js";
export * from "./signatures.js";
