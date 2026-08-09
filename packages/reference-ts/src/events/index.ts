import { SPEC_VERSION, parseMemoryEnvelope, validateMemoryEnvelope, type MemoryEnvelope, type PremiseEvent, type PremiseEventType, type ValidationIssue, type ValidatorResult, type VersionReference } from "@premise/protocol-types";

const eventTypes = new Set<PremiseEventType>([
  "MemoryRegistered",
  "MemoryDerived",
  "SourceChanged",
  "MemoryStaled",
  "MemoryInvalidated",
  "MemoryRevalidated",
  "MemoryReplaced"
]);
const results = new Set<ValidatorResult>(["UNCHANGED", "CHANGED", "MISSING", "UNKNOWN"]);

function cloneEvent(event: PremiseEvent): PremiseEvent {
  return JSON.parse(JSON.stringify(event)) as PremiseEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isVersion(value: unknown): value is VersionReference {
  return isRecord(value) && typeof value.scheme === "string" && value.scheme.length > 0 && typeof value.token === "string" && value.token.length > 0;
}

function add(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

export function validatePremiseEvent(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return [{ path: "$", message: "must be an object" }];
  const allowed = new Set(["specVersion", "eventId", "type", "occurredAt", "memoryId", "payload"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) add(issues, `$.${key}`, "is not a permitted event field");
  if (input.specVersion !== SPEC_VERSION) add(issues, "$.specVersion", `must equal ${SPEC_VERSION}`);
  if (typeof input.eventId !== "string" || input.eventId.length === 0) add(issues, "$.eventId", "must be a non-empty string");
  if (typeof input.type !== "string" || !eventTypes.has(input.type as PremiseEventType)) add(issues, "$.type", "must be a PREMiSE event type");
  if (!isDateTime(input.occurredAt)) add(issues, "$.occurredAt", "must be an ISO date-time string");
  if (input.type !== "SourceChanged" && (typeof input.memoryId !== "string" || input.memoryId.length === 0)) add(issues, "$.memoryId", "is required for this event type");
  if (!isRecord(input.payload)) {
    add(issues, "$.payload", "must be an object");
    return issues;
  }
  switch (input.type) {
    case "MemoryRegistered":
      if (!isRecord(input.payload.envelope)) add(issues, "$.payload.envelope", "is required");
      else {
        issues.push(...validateMemoryEnvelope(input.payload.envelope).map((issue) => ({ path: `$.payload.envelope${issue.path.slice(1)}`, message: issue.message })));
        if (isRecord(input.payload.envelope) && input.payload.envelope.memoryId !== input.memoryId) add(issues, "$.memoryId", "must match payload.envelope.memoryId");
      }
      break;
    case "MemoryDerived":
      if (!Array.isArray(input.payload.dependsOn) || input.payload.dependsOn.length === 0 || input.payload.dependsOn.some((id) => typeof id !== "string" || id.length === 0) || new Set(input.payload.dependsOn).size !== input.payload.dependsOn.length) add(issues, "$.payload.dependsOn", "must be a non-empty array of unique memory IDs");
      break;
    case "SourceChanged":
      if (typeof input.payload.sourceUri !== "string" || input.payload.sourceUri.length === 0) add(issues, "$.payload.sourceUri", "is required");
      if (!isVersion(input.payload.version)) add(issues, "$.payload.version", "is required and must contain scheme/token");
      break;
    case "MemoryStaled":
    case "MemoryInvalidated":
      if (typeof input.payload.reason !== "string" || input.payload.reason.length === 0) add(issues, "$.payload.reason", "is required");
      break;
    case "MemoryRevalidated":
      if (typeof input.payload.result !== "string" || !results.has(input.payload.result as ValidatorResult)) add(issues, "$.payload.result", "is required and must be a validator result");
      if ((input.payload.result === "UNCHANGED" || input.payload.result === "CHANGED") && !isVersion(input.payload.version)) add(issues, "$.payload.version", "is required for this validator result");
      const expectedStatus = input.payload.result === "UNCHANGED" ? "FRESH" : input.payload.result === "CHANGED" || input.payload.result === "MISSING" ? "INVALID" : "UNKNOWN";
      if (input.payload.status !== expectedStatus) add(issues, "$.payload.status", `must be ${expectedStatus} for ${String(input.payload.result)}`);
      break;
    case "MemoryReplaced":
      if (typeof input.payload.replacementMemoryId !== "string" || input.payload.replacementMemoryId.length === 0) add(issues, "$.payload.replacementMemoryId", "is required");
      break;
  }
  return issues;
}

export class PremiseEventValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(`Invalid PREMiSE event (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "PremiseEventValidationError";
    this.issues = issues;
  }
}

export function parsePremiseEvent(input: unknown): PremiseEvent {
  const issues = validatePremiseEvent(input);
  if (issues.length > 0) throw new PremiseEventValidationError(issues);
  return input as PremiseEvent;
}

export class EventJournal {
  private readonly entries: PremiseEvent[] = [];
  private readonly ids = new Set<string>();

  append(input: unknown): PremiseEvent {
    const event = parsePremiseEvent(input);
    if (this.ids.has(event.eventId)) throw new Error(`Duplicate eventId: ${event.eventId}`);
    this.ids.add(event.eventId);
    this.entries.push(cloneEvent(event));
    return event;
  }

  appendMany(events: readonly unknown[]): readonly PremiseEvent[] {
    return events.map((event) => this.append(event));
  }

  all(): readonly PremiseEvent[] {
    return this.entries.map((event) => cloneEvent(event));
  }

  history(memoryId: string): readonly PremiseEvent[] {
    return this.entries.filter((event) => event.memoryId === memoryId).map((event) => cloneEvent(event));
  }

  get size(): number {
    return this.entries.length;
  }
}

export function eventForRegistration(envelope: MemoryEnvelope, eventId: string, occurredAt: string): PremiseEvent {
  return { specVersion: SPEC_VERSION, eventId, type: "MemoryRegistered", occurredAt, memoryId: envelope.memoryId, payload: { envelope } };
}
