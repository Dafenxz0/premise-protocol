export const PROTOCOL = "premise/1" as const;

export type State = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";
export type Decision = "USE" | "REVALIDATE" | "REJECT";

export interface StateResult {
  readonly state: State;
  readonly decision: Decision;
  readonly [key: string]: unknown;
}

export interface VectorResult {
  readonly id: string;
  readonly output: unknown;
}

type JsonObject = { readonly [key: string]: unknown };

function objectValue(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as JsonObject;
}

function result(state: State, extra: JsonObject = {}): StateResult {
  const decision: Decision = state === "FRESH" ? "USE" : state === "STALE" ? "REVALIDATE" : "REJECT";
  return { state, decision, ...extra };
}

function memoriesIn(vector: JsonObject): readonly JsonObject[] {
  if (Array.isArray(vector.memories)) return vector.memories.map((memory, index) => objectValue(memory, `memories[${index}]`));
  return vector.memory === undefined ? [] : [objectValue(vector.memory, "memory")];
}

function stateForMemory(vector: JsonObject, memoryId: string, seen: ReadonlySet<string>): StateResult {
  const tenant = vector.tenant;
  const memory = memoriesIn(vector).find((candidate) => candidate.memoryId === memoryId);
  if (memory === undefined || (tenant !== undefined && memory.tenantId !== tenant)) return result("UNKNOWN");
  if (seen.has(memoryId)) return result("UNKNOWN");
  if (memory.invalidation !== undefined && memory.invalidation !== null) return result("INVALID");

  const nextSeen = new Set(seen);
  nextSeen.add(memoryId);
  let dependencyState: State = "FRESH";
  const dependencies = Array.isArray(memory.dependencies) ? memory.dependencies : [];
  for (const dependency of dependencies) {
    if (typeof dependency !== "string") return result("UNKNOWN");
    const checked = stateForMemory(vector, dependency, nextSeen);
    if (checked.state === "INVALID" || checked.state === "UNKNOWN") return result(checked.state);
    if (checked.state === "STALE") dependencyState = "STALE";
  }
  if (dependencyState === "STALE") return result("STALE");

  const observations = vector.observations === undefined ? {} : objectValue(vector.observations, "observations");
  const evidence = Array.isArray(memory.evidence) ? memory.evidence : [];
  for (const item of evidence) {
    const entry = objectValue(item, "evidence");
    const validity = entry.validity;
    if (validity === "INVALID" || validity === "UNKNOWN" || validity === "STALE") return result(validity);
    const source = entry.source;
    const observation = typeof source === "string" ? observations[source] : undefined;
    if (observation === undefined) return result("UNKNOWN");
    const current = objectValue(observation, `observations.${String(source)}`);
    if (current.available !== true) return result("UNKNOWN");
    if (entry.version === undefined || current.version === undefined) return result("UNKNOWN");
    if (entry.version !== current.version) return result("STALE");
  }
  return result("FRESH");
}

function replayResult(vector: JsonObject): JsonObject {
  const applied = new Map<string, string>();
  let replayed = 0;
  let conflicts = 0;
  const operations = Array.isArray(vector.operations) ? vector.operations : [];
  for (const item of operations) {
    const operation = objectValue(item, "operations[]");
    const key = String(operation.idempotencyKey);
    const payload = stableJson(operation.payload);
    const previous = applied.get(key);
    if (previous === undefined) applied.set(key, payload);
    else if (previous === payload) replayed += 1;
    else conflicts += 1;
  }
  return { applied: applied.size, replayed, conflicts };
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function runVector(input: unknown): VectorResult {
  const vector = objectValue(input, "vector");
  const id = typeof vector.id === "string" ? vector.id : "";
  if (id.length === 0) throw new TypeError("vector.id must be a non-empty string");
  let output: unknown;
  switch (vector.operation) {
    case "check": {
      const target = typeof vector.target === "string" ? vector.target : objectValue(vector.memory, "memory").memoryId;
      output = stateForMemory(vector, String(target), new Set());
      break;
    }
    case "revalidate": {
      const items = Array.isArray(vector.results)
        ? vector.results
        : vector.result === undefined ? [] : [{ result: vector.result }];
      output = items.map((item) => {
        const revalidation = objectValue(item, "results[]");
        if (revalidation.result === "UNCHANGED") return result("FRESH");
        if (revalidation.result === "UNKNOWN") return result("UNKNOWN");
        if (revalidation.result === "CHANGED" || revalidation.result === "MISSING") return result("INVALID");
        throw new Error(`Unsupported revalidation result: ${String(revalidation.result)}`);
      });
      break;
    }
    case "replay":
      output = replayResult(vector);
      break;
    case "write": {
      const safe = vector.validatedVersion !== undefined && vector.validatedVersion === vector.writeVersion;
      output = result(safe ? "FRESH" : "STALE", { toctouEscaped: false });
      break;
    }
    default:
      throw new Error(`Unsupported operation: ${String(vector.operation)}`);
  }
  return { id, output };
}

export function runVectors(input: unknown): readonly VectorResult[] {
  if (Array.isArray(input)) return input.map(runVector);
  const document = objectValue(input, "vector document");
  return Array.isArray(document.vectors) && document.vectors.every((item) => typeof item === "object")
    ? document.vectors.map(runVector)
    : [runVector(document)];
}
