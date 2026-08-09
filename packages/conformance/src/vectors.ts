import { isValidationResult, validateMemoryEnvelope, type MemoryStatus } from "@premise/protocol-types";

export interface VectorManifestEntry {
  readonly path: string;
  readonly vectorIds: readonly string[];
  readonly covers?: readonly string[];
}

export interface VectorManifest {
  readonly format: "premise-test-vector-manifest/0.1";
  readonly protocol: "premise/0.1";
  readonly files: readonly VectorManifestEntry[];
}

export interface VectorSuite {
  readonly format: "premise-test-vector-suite/0.1";
  readonly protocol: "premise/0.1";
  readonly suiteId: string;
  readonly vectors: readonly {
    readonly format: "premise-test-vector/0.1";
    readonly protocol: "premise/0.1";
    readonly vectorId: string;
    readonly category: "positive" | "negative" | "transition";
    readonly description: string;
    readonly initial: unknown;
    readonly steps: readonly unknown[];
  }[];
}

export interface VectorValidationReport {
  readonly valid: boolean;
  readonly suiteCount: number;
  readonly vectorCount: number;
  readonly errors: readonly string[];
}

const operations = new Set(["register", "derive", "signal", "advance_time", "validate", "check", "capabilities", "register_graph", "replay"]);
const eventTypes = new Set(["MemoryRegistered", "MemoryDerived", "SourceChanged", "MemoryStaled", "MemoryInvalidated", "MemoryRevalidated", "MemoryReplaced"]);
const statuses = new Set<MemoryStatus>(["FRESH", "STALE", "INVALID", "UNKNOWN"]);
const capabilities = new Set(["RECORD", "DEPENDENCY", "REVALIDATION", "RETRIEVAL", "GATE"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

function validateCapabilitiesShape(value: unknown): boolean {
  if (!isRecord(value) || value.specVersion !== "premise/0.1" || !Array.isArray(value.capabilities) || value.capabilities.length === 0) return false;
  if (new Set(value.capabilities).size !== value.capabilities.length || !value.capabilities.every((capability) => typeof capability === "string" && capabilities.has(capability))) return false;
  return value.profile === "PREMiSE-compatible v0.1";
}

function validateCanonicalEvent(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) { errors.push(`${path}: event must be an object`); return; }
  if (value.specVersion !== "premise/0.1" || typeof value.eventId !== "string" || !isDateTime(value.occurredAt) || typeof value.type !== "string" || !eventTypes.has(value.type) || !isRecord(value.payload)) errors.push(`${path}: invalid canonical event identity`);
  if (value.type !== "SourceChanged" && (typeof value.memoryId !== "string" || value.memoryId.length === 0)) errors.push(`${path}: memoryId is required for ${String(value.type)}`);
  if (value.type === "MemoryRegistered" && isRecord(value.payload)) {
    const envelopeIssues = validateMemoryEnvelope(value.payload.envelope);
    for (const issue of envelopeIssues) errors.push(`${path}.payload.envelope${issue.path.slice(1)}: ${issue.message}`);
    if (isRecord(value.payload.envelope) && value.payload.envelope.memoryId !== value.memoryId) errors.push(`${path}: event and envelope memory IDs differ`);
  }
  if (value.type === "MemoryRevalidated" && isRecord(value.payload)) {
    const result = value.payload.result;
    const expected = result === "UNCHANGED" ? "FRESH" : result === "CHANGED" || result === "MISSING" ? "INVALID" : "UNKNOWN";
    if (value.payload.status !== expected) errors.push(`${path}.payload.status: inconsistent with result`);
  }
}

function validateStep(step: unknown, path: string, errors: string[]): void {
  if (!isRecord(step)) { errors.push(`${path}: step must be an object`); return; }
  if (typeof step.id !== "string" || step.id.length === 0) errors.push(`${path}.id: required`);
  if (typeof step.operation !== "string" || !operations.has(step.operation)) { errors.push(`${path}.operation: unsupported operation`); return; }
  if (!isRecord(step.input)) { errors.push(`${path}.input: required object`); return; }
  if (step.expect !== undefined && !isRecord(step.expect)) errors.push(`${path}.expect: must be an object`);
  const input = step.input;
  switch (step.operation) {
    case "register":
    case "derive": {
      const envelope = input.envelope;
      if (step.operation === "derive" && envelope === undefined && typeof input.memoryId === "string" && Array.isArray(input.dependsOn)) {
        if (input.dependsOn.length === 0 || input.dependsOn.some((id) => typeof id !== "string" || id.length === 0)) errors.push(`${path}.input.dependsOn: derive requires non-empty dependencies`);
      } else {
        const issues = validateMemoryEnvelope(envelope);
        for (const issue of issues) errors.push(`${path}.input.envelope${issue.path.slice(1)}: ${issue.message}`);
        if (step.operation === "derive" && isRecord(envelope) && (!Array.isArray(envelope.dependsOn) || envelope.dependsOn.length === 0)) errors.push(`${path}.input.envelope.dependsOn: derive requires dependencies`);
      }
      break;
    }
    case "signal":
      if (input.event !== undefined) validateCanonicalEvent(input.event, `${path}.input.event`, errors);
      else if (typeof input.memoryId !== "string" || input.change !== "version") errors.push(`${path}.input: requires a canonical event or graph signal projection`);
      break;
    case "advance_time":
      if (!isDateTime(input.now)) errors.push(`${path}.input.now: must be an ISO date-time`);
      break;
    case "validate":
      if (!Array.isArray(input.memoryIds) || input.memoryIds.some((id) => typeof id !== "string" || id.length === 0) || !isRecord(input.results)) errors.push(`${path}.input: requires memoryIds and results`);
      else for (const memoryId of input.memoryIds) {
        const result = input.results[memoryId];
        if (!isValidationResult(result) || result.memoryId !== memoryId) errors.push(`${path}.input.results.${memoryId}: invalid validation result`);
      }
      break;
    case "check":
      if (input.memoryIds === undefined && !Array.isArray(input.statuses)) errors.push(`${path}.input: requires memoryIds or statuses`);
      break;
    case "capabilities":
      if (!validateCapabilitiesShape(input)) errors.push(`${path}.input: invalid capabilities declaration`);
      break;
    case "register_graph":
      if (!Array.isArray(input.edges) || input.edges.some((edge) => !Array.isArray(edge) || edge.length !== 2 || edge.some((id) => typeof id !== "string" || id.length === 0))) errors.push(`${path}.input.edges: requires pairs of memory IDs`);
      break;
    case "replay":
      if (!Array.isArray(input.events) || input.events.length === 0) errors.push(`${path}.input.events: requires canonical events`);
      else input.events.forEach((event, index) => validateCanonicalEvent(event, `${path}.input.events[${index}]`, errors));
      break;
  }
}

export function validateTestVectors(manifest: VectorManifest, suites: Readonly<Record<string, VectorSuite>>): VectorValidationReport {
  const errors: string[] = [];
  const seen = new Set<string>();
  let vectorCount = 0;
  for (const entry of manifest.files ?? []) {
    const suite = suites[entry.path];
    if (!suite) { errors.push(`${entry.path}: suite is missing`); continue; }
    if (suite.format !== "premise-test-vector-suite/0.1" || suite.protocol !== "premise/0.1") errors.push(`${entry.path}: invalid suite format or protocol`);
    const actual = (suite.vectors ?? []).map((vector) => vector.vectorId);
    if (actual.length === 0) errors.push(`${entry.path}: contains no vectors`);
    for (const id of actual) {
      if (seen.has(id)) errors.push(`${entry.path}: duplicate vector id ${id}`);
      seen.add(id);
      vectorCount += 1;
    }
    const expected = [...(entry.vectorIds ?? [])].sort();
    const actualSorted = [...actual].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actualSorted)) errors.push(`${entry.path}: manifest vectorIds do not match suite vectors`);
    for (const vector of suite.vectors ?? []) {
      const vectorPath = `${entry.path}/${vector.vectorId}`;
      if (vector.format !== "premise-test-vector/0.1" || vector.protocol !== "premise/0.1" || typeof vector.vectorId !== "string" || !["positive", "negative", "transition"].includes(vector.category) || typeof vector.description !== "string") errors.push(`${vectorPath}: invalid vector metadata`);
      if (!isRecord(vector.initial)) errors.push(`${vectorPath}: initial state is required`);
      if (!Array.isArray(vector.steps) || vector.steps.length === 0) errors.push(`${vectorPath}: requires executable steps`);
      else {
        const stepIds = new Set<string>();
        vector.steps.forEach((step, index) => {
          validateStep(step, `${vectorPath}/steps[${index}]`, errors);
          if (isRecord(step) && typeof step.id === "string") {
            if (stepIds.has(step.id)) errors.push(`${vectorPath}: duplicate step id ${step.id}`);
            stepIds.add(step.id);
          }
        });
      }
    }
  }
  return { valid: errors.length === 0, suiteCount: manifest.files?.length ?? 0, vectorCount, errors };
}

export interface VectorExecutionReport {
  readonly valid: boolean;
  readonly vectorCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly failures: readonly string[];
}

interface ExecutedMemory {
  direct: MemoryStatus;
  status: MemoryStatus;
  dependsOn: string[];
  provenance: readonly Record<string, unknown>[];
  expiresAt?: string;
}

function expectationMatches(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => expectationMatches(actual[index], item));
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => expectationMatches((actual as Record<string, unknown>)[key], value));
}

function decision(status: MemoryStatus): "USABLE" | "REVALIDATE" | "REJECT" {
  return status === "FRESH" ? "USABLE" : status === "INVALID" ? "REJECT" : "REVALIDATE";
}

function aggregate(statusesToAggregate: readonly MemoryStatus[]): MemoryStatus {
  if (statusesToAggregate.includes("INVALID")) return "INVALID";
  if (statusesToAggregate.includes("UNKNOWN")) return "UNKNOWN";
  if (statusesToAggregate.includes("STALE")) return "STALE";
  return "FRESH";
}

function projectedState(memory: ExecutedMemory): Record<string, unknown> {
  return {
    status: memory.status,
    dependsOn: [...memory.dependsOn],
    provenanceVersions: memory.provenance.flatMap((source) => {
      const version = source.version;
      return isRecord(version) && typeof source.sourceUri === "string" && typeof version.scheme === "string" && typeof version.token === "string"
        ? [{ sourceUri: source.sourceUri, scheme: version.scheme, token: version.token }]
        : [];
    })
  };
}

function executeVector(vector: VectorSuite["vectors"][number]): readonly string[] {
  const memories = new Map<string, ExecutedMemory>();
  const dependents = new Map<string, Set<string>>();
  const history: { type: string; memoryId?: string; at: string }[] = [];
  let clock = isRecord(vector.initial) && isRecord(vector.initial.clock) && typeof vector.initial.clock.now === "string" ? vector.initial.clock.now : "2026-08-09T19:20:00Z";
  const failures: string[] = [];
  const addDependency = (memoryId: string, dependencyId: string): void => {
    const set = dependents.get(dependencyId) ?? new Set<string>();
    set.add(memoryId);
    dependents.set(dependencyId, set);
  };
  const recompute = (): void => {
    for (let round = 0; round <= memories.size; round += 1) {
      let changed = false;
      for (const memory of memories.values()) {
        const next = aggregate([memory.direct, ...memory.dependsOn.map((id) => memories.get(id)?.status ?? "UNKNOWN")]);
        if (next !== memory.status) { memory.status = next; changed = true; }
        if (memory.expiresAt !== undefined && Date.parse(clock) >= Date.parse(memory.expiresAt) && memory.direct === "FRESH") { memory.status = aggregate(["STALE", ...memory.dependsOn.map((id) => memories.get(id)?.status ?? "UNKNOWN")]); changed = true; }
      }
      if (!changed) return;
    }
    throw new Error("Vector graph did not converge");
  };
  const reachable = (root: string): string[] => {
    const result = new Set<string>([root]);
    const queue = [root];
    while (queue.length > 0) for (const dependent of dependents.get(queue.shift()!) ?? []) if (!result.has(dependent)) { result.add(dependent); queue.push(dependent); }
    return [...result].sort();
  };
  const addMemory = (memoryId: string, direct: MemoryStatus, dependsOn: readonly string[], provenance: readonly Record<string, unknown>[] = [], expiresAt?: string): void => {
    if (memories.has(memoryId)) throw new Error(`Memory already exists: ${memoryId}`);
    memories.set(memoryId, { direct, status: direct, dependsOn: [...dependsOn], provenance, ...(expiresAt ? { expiresAt } : {}) });
    for (const dependency of dependsOn) addDependency(memoryId, dependency);
    recompute();
  };
  const transitionEvent = (memoryId: string, status: MemoryStatus, at: string, result?: string): string => {
    const type = status === "INVALID" ? "MemoryInvalidated" : status === "FRESH" || result !== undefined ? "MemoryRevalidated" : "MemoryStaled";
    history.push({ type, memoryId, at });
    return type;
  };
  const replay = (events: readonly Record<string, unknown>[]): { state: Record<string, unknown>; history: Record<string, string[]>; finalStatus: MemoryStatus | undefined } => {
    const states = new Map<string, MemoryStatus>();
    const histories = new Map<string, string[]>();
    for (const event of events) {
      const id = typeof event.memoryId === "string" ? event.memoryId : undefined;
      if (id) histories.set(id, [...(histories.get(id) ?? []), String(event.eventId)]);
      if (event.type === "MemoryRegistered" && id && isRecord(event.payload) && isRecord(event.payload.envelope) && isRecord(event.payload.envelope.validity)) states.set(id, event.payload.envelope.validity.status as MemoryStatus);
      else if (id && event.type === "MemoryStaled" && states.get(id) !== "INVALID") states.set(id, "STALE");
      else if (id && event.type === "MemoryInvalidated") states.set(id, "INVALID");
      else if (id && event.type === "MemoryRevalidated" && isRecord(event.payload) && states.get(id) !== "INVALID") states.set(id, event.payload.status as MemoryStatus);
      else if (id && event.type === "MemoryReplaced") states.set(id, "FRESH");
    }
    const state = Object.fromEntries([...states.keys()].sort().map((id) => [id, states.get(id)]));
    const historyRecord = Object.fromEntries([...histories.keys()].sort().map((id) => [id, histories.get(id)!])) as Record<string, string[]>;
    const firstId = [...states.keys()][0];
    return { state, history: historyRecord, finalStatus: firstId ? states.get(firstId) : undefined };
  };

  for (const rawStep of vector.steps) {
    if (!isRecord(rawStep) || !isRecord(rawStep.input)) continue;
    const step = rawStep;
    const input = step.input as Record<string, unknown>;
    let actual: unknown = { accepted: true, events: [] };
    try {
      switch (step.operation) {
        case "register": {
          const envelope = input.envelope as Record<string, unknown>;
          const validity = envelope.validity as Record<string, unknown>;
          addMemory(String(envelope.memoryId), validity.status as MemoryStatus, envelope.dependsOn as string[], (envelope.provenance as readonly Record<string, unknown>[] | undefined) ?? [], typeof validity.expiresAt === "string" ? validity.expiresAt : undefined);
          history.push({ type: "MemoryRegistered", memoryId: String(envelope.memoryId), at: String(validity.checkedAt) });
          actual = { accepted: true, events: [{ type: "MemoryRegistered", memoryId: envelope.memoryId, at: validity.checkedAt }], state: { [String(envelope.memoryId)]: projectedState(memories.get(String(envelope.memoryId))!) } };
          break;
        }
        case "derive": {
          const source = isRecord(input.envelope) ? input.envelope : input;
          const memoryId = String(source.memoryId);
          const dependsOn = source.dependsOn as string[];
          if (dependsOn.includes(memoryId) || dependsOn.some((dependency) => !memories.has(dependency))) throw new Error("DEPENDENCY_CYCLE");
          const validity = isRecord(source.validity) ? source.validity : { status: "FRESH", checkedAt: clock };
          addMemory(memoryId, validity.status as MemoryStatus, dependsOn, (source.provenance as readonly Record<string, unknown>[] | undefined) ?? []);
          history.push({ type: "MemoryDerived", memoryId, at: String(validity.checkedAt ?? clock) });
          actual = { accepted: true, events: [{ type: "MemoryDerived", memoryId, dependsOn, at: validity.checkedAt ?? clock }], state: { [memoryId]: projectedState(memories.get(memoryId)!) } };
          break;
        }
        case "register_graph": {
          for (const edge of input.edges as readonly (readonly [string, string])[]) {
            for (const id of edge) if (!memories.has(id)) memories.set(id, { direct: "FRESH", status: "FRESH", dependsOn: [], provenance: [] });
            const [dependent, dependency] = edge;
            memories.get(dependent)!.dependsOn.push(dependency);
            addDependency(dependent, dependency);
          }
          recompute();
          break;
        }
        case "signal": {
          const event = isRecord(input.event) ? input.event : undefined;
          const sourceUri = event && isRecord(event.payload) && typeof event.payload.sourceUri === "string" ? event.payload.sourceUri : undefined;
          const roots = event ? [...memories.entries()].filter(([, memory]) => memory.provenance.some((source) => source.sourceUri === sourceUri)).map(([id]) => id) : [String(input.memoryId)];
          const affected = [...new Set(roots.flatMap(reachable))].sort();
          const transitionTypes: string[] = [];
          for (const id of affected) {
            const memory = memories.get(id);
            if (memory && memory.direct !== "INVALID") { memory.direct = "STALE"; transitionTypes.push(transitionEvent(id, "STALE", event && typeof event.occurredAt === "string" ? event.occurredAt : clock)); }
          }
          recompute();
          actual = event ? { status: roots.length > 0 ? memories.get(roots[0]!)?.status : "UNKNOWN", event: transitionTypes[0] } : { staled: affected };
          if (!event) actual = { staled: affected, untouched: [...memories.keys()].filter((id) => !affected.includes(id)).sort() };
          break;
        }
        case "advance_time":
          clock = String(input.now);
          recompute();
          break;
        case "validate": {
          const ids = input.memoryIds as readonly string[];
          const results = input.results as Record<string, Record<string, unknown>>;
          for (const id of ids) {
            const memory = memories.get(id);
            if (!memory) throw new Error(`Unknown memory: ${id}`);
            const result = results[id];
            if (!result) throw new Error(`Missing validation result for ${id}`);
            const next = result.result === "UNCHANGED" ? "FRESH" : result.result === "UNKNOWN" ? "UNKNOWN" : "INVALID";
            if (memory.direct !== "INVALID" || next === "INVALID") memory.direct = next;
            const type = transitionEvent(id, next, String(result.checkedAt), String(result.result));
            recompute();
            actual = { status: memory.status, decision: decision(memory.status), event: type };
          }
          break;
        }
        case "check":
          if (Array.isArray(input.statuses)) actual = { decisions: Object.fromEntries((input.statuses as MemoryStatus[]).map((status) => [status, decision(status)])) };
          else {
            const items = (input.memoryIds as readonly string[]).map((id) => ({ memoryId: id, decision: decision(memories.get(id)?.status ?? "UNKNOWN") }));
            const first = (input.memoryIds as readonly string[])[0];
            const firstStatus = first ? memories.get(first)?.status : undefined;
            actual = { accepted: true, events: [], result: { items }, ...(firstStatus ? { status: firstStatus, decision: decision(firstStatus) } : {}) };
          }
          break;
        case "capabilities": {
          const declared = input.capabilities as readonly string[];
          const missing = ["RECORD", "DEPENDENCY", "REVALIDATION"].filter((capability) => !declared.includes(capability));
          actual = { compatible: missing.length === 0, profile: input.profile, missing };
          break;
        }
        case "replay": {
          const events = input.events as readonly Record<string, unknown>[];
          const first = replay(events);
          const second = replay(events);
          actual = { deterministic: JSON.stringify(first) === JSON.stringify(second), sameState: JSON.stringify(first.state) === JSON.stringify(second.state), historyPreserved: Object.values(first.history).some((eventsForMemory) => eventsForMemory.length > 1), finalStatus: first.finalStatus };
          break;
        }
      }
    } catch (error) {
      actual = { accepted: false, error: error instanceof Error ? error.message : String(error), events: [] };
    }
    if (step.expect !== undefined && !expectationMatches(actual, step.expect)) failures.push(`${vector.vectorId}/${String(step.id)}: expectation did not match (${JSON.stringify(actual)})`);
  }
  return failures;
}

export function executeTestVectors(manifest: VectorManifest, suites: Readonly<Record<string, VectorSuite>>): VectorExecutionReport {
  const failures: string[] = [];
  let vectorCount = 0;
  for (const entry of manifest.files ?? []) {
    const suite = suites[entry.path];
    if (!suite) continue;
    for (const vector of suite.vectors ?? []) {
      vectorCount += 1;
      failures.push(...executeVector(vector));
    }
  }
  return { valid: failures.length === 0, vectorCount, passedCount: vectorCount - new Set(failures.map((failure) => failure.split(":")[0])).size, failedCount: new Set(failures.map((failure) => failure.split(":")[0])).size, failures };
}
