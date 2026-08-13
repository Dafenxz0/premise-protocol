import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
// The physical lab deliberately consumes the built package artifact.
import { PremiseRuntime, RuntimeInstrumentationRecorder } from "../../../../packages/runtime-core/dist/index.js";
import { DeterministicMutableSourceAdapter } from "./source-adapter.mjs";

export const PHYSICAL_TRACE_FORMAT = "premise-efficiency-lab/physical-trace/v1";
export const PHYSICAL_COUNTER_SCHEMA = "runtime-core/instrumentation/v1";
export const DEFAULT_TASK_ID = "task-0001";
export const DEFAULT_CANDIDATE_ID = "runtime-core";
export const DEFAULT_TENANT_ID = "tenant:efficiency-lab";
export const DEFAULT_NOW = "2026-08-13T00:00:00.000Z";

const DEFAULT_NODES = Object.freeze([
  Object.freeze({ id: "memory:root" }),
  Object.freeze({ id: "memory:leaf", dependsOn: ["memory:root"] })
]);

function cloneJson(value) {
  return structuredClone(value);
}

function assertObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function asArray(value, name) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  throw new TypeError(`${name} must be an array or string`);
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeNow(value) {
  const now = value ?? DEFAULT_NOW;
  const timestamp = typeof now === "function" ? now() : now;
  assertNonEmptyString(timestamp, "now");
  if (Number.isNaN(Date.parse(timestamp))) throw new RangeError("now must be an ISO date-time string");
  return timestamp;
}

function nodeId(value, index) {
  if (typeof value === "string") return value;
  assertObject(value, `nodes[${index}]`);
  const id = value.id ?? value.memoryId;
  assertNonEmptyString(id, `nodes[${index}].id`);
  return id;
}

function nodeDependencies(value) {
  if (typeof value === "string") return [];
  return unique(asArray(value.dependsOn ?? value.dependencies, "node dependencies"));
}

function topologicalOrder(nodes, dependencies) {
  const positions = new Map(nodes.map((id, index) => [id, index]));
  const remaining = new Map(nodes.map((id) => [id, new Set(dependencies.get(id) ?? [])]));
  const dependents = new Map(nodes.map((id) => [id, []]));
  for (const [id, required] of remaining) {
    for (const dependency of required) {
      if (!remaining.has(dependency)) throw new RangeError(`Unknown dependency ${dependency} for ${id}`);
      dependents.get(dependency).push(id);
    }
  }
  const ready = nodes.filter((id) => remaining.get(id).size === 0);
  const result = [];
  while (ready.length > 0) {
    ready.sort((left, right) => positions.get(left) - positions.get(right));
    const current = ready.shift();
    result.push(current);
    for (const dependent of dependents.get(current)) {
      const required = remaining.get(dependent);
      required.delete(current);
      if (required.size === 0) ready.push(dependent);
    }
  }
  if (result.length !== nodes.length) throw new Error("graph contains a dependency cycle");
  return result;
}

function normalizeGraph(options) {
  const graph = options.graph ?? {};
  assertObject(graph, "graph");
  let rawNodes = options.nodes ?? graph.nodes;
  if (rawNodes === undefined && options.nodeCount !== undefined) {
    if (!Number.isSafeInteger(options.nodeCount) || options.nodeCount < 1) throw new RangeError("nodeCount must be a positive integer");
    rawNodes = Array.from({ length: options.nodeCount }, (_, index) => ({
      id: `memory:node-${String(index).padStart(4, "0")}`,
      ...(index === 0 ? {} : { dependsOn: [`memory:node-${String(index - 1).padStart(4, "0")}`] })
    }));
  }
  rawNodes ??= DEFAULT_NODES;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) throw new RangeError("nodes must contain at least one node");
  const ids = rawNodes.map(nodeId);
  if (new Set(ids).size !== ids.length) throw new RangeError("nodes must have unique IDs");
  const descriptions = new Map(rawNodes.map((value, index) => [ids[index], typeof value === "string" ? {} : value]));
  const dependencies = new Map(ids.map((id, index) => [id, new Set(nodeDependencies(rawNodes[index]))]));
  const rawEdges = options.edges ?? graph.edges ?? [];
  if (!Array.isArray(rawEdges)) throw new TypeError("edges must be an array");
  for (const edge of rawEdges) {
    assertObject(edge, "edge");
    assertNonEmptyString(edge.from, "edge.from");
    assertNonEmptyString(edge.to, "edge.to");
    if (!dependencies.has(edge.from) || !dependencies.has(edge.to)) throw new RangeError("edge references an unknown node");
    dependencies.get(edge.to).add(edge.from);
  }
  if (options.dependencies !== undefined) {
    assertObject(options.dependencies, "dependencies");
    for (const [id, required] of Object.entries(options.dependencies)) {
      if (!dependencies.has(id)) throw new RangeError(`Unknown dependency node ${id}`);
      for (const dependency of asArray(required, `dependencies.${id}`)) dependencies.get(id).add(dependency);
    }
  }
  const order = topologicalOrder(ids, dependencies);
  return order.map((id) => {
    const description = descriptions.get(id);
    const dependsOn = [...dependencies.get(id)];
    const evidence = description.evidence === undefined ? undefined : cloneJson(description.evidence);
    const suppliedSourceUri = description.sourceUri ?? description.source?.sourceUri;
    const sourceUri = suppliedSourceUri ?? (dependsOn.length === 0 ? `deterministic://source/${encodeURIComponent(id)}` : undefined);
    return Object.freeze({
      id,
      dependsOn: Object.freeze(dependsOn),
      sourceUri,
      evidence,
      version: description.version ?? description.versionToken,
      content: description.content,
      status: description.status ?? "FRESH",
      policy: description.policy ?? "VERSIONED",
      expiresAt: description.expiresAt,
      evidenceId: description.evidenceId
    });
  });
}

function sourceDefinitionFor(descriptor, evidence) {
  if (descriptor.sourceUri !== undefined) return { sourceUri: descriptor.sourceUri, version: descriptor.version };
  if (evidence?.sourceUri !== undefined) return { sourceUri: evidence.sourceUri, version: evidence.version };
  return undefined;
}

function ensureSources(adapter, descriptors, options) {
  for (const descriptor of descriptors) {
    const suppliedEvidence = descriptor.evidence ?? [];
    const definition = sourceDefinitionFor(descriptor, suppliedEvidence[0]);
    if (definition !== undefined && !adapter.has(definition.sourceUri)) {
      adapter.register(definition.sourceUri, { version: definition.version, value: descriptor.content ?? null });
    }
    for (const evidence of suppliedEvidence) {
      if (!adapter.has(evidence.sourceUri)) adapter.register(evidence.sourceUri, { version: evidence.version });
    }
  }
  if (options.sourceUri !== undefined && !adapter.has(options.sourceUri)) {
    adapter.register(options.sourceUri, { version: options.version, value: options.value });
  }
}

function evidenceFor(descriptor, adapter, at) {
  if (descriptor.evidence !== undefined) {
    return descriptor.evidence.map((item, index) => {
      assertObject(item, `${descriptor.id}.evidence[${index}]`);
      const state = adapter.current(item.sourceUri);
      if (state === undefined) throw new RangeError(`Unknown source ${item.sourceUri}`);
      return {
        ...item,
        evidenceId: item.evidenceId ?? `evidence:${item.sourceUri}`,
        observedAt: item.observedAt ?? at,
        version: item.version ?? state.version,
        validator: item.validator ?? { id: "deterministic-source-adapter", operation: "read" }
      };
    });
  }
  if (descriptor.sourceUri === undefined) return [];
  const state = adapter.current(descriptor.sourceUri);
  if (state === undefined) throw new RangeError(`Unknown source ${descriptor.sourceUri}`);
  return [{
    evidenceId: descriptor.evidenceId ?? `evidence:${descriptor.sourceUri}`,
    sourceUri: descriptor.sourceUri,
    observedAt: at,
    version: state.version,
    validator: { id: "deterministic-source-adapter", operation: "read" }
  }];
}

function envelopeFor(descriptor, evidence, tenantId, at) {
  const validity = {
    status: descriptor.status,
    checkedAt: at,
    policy: descriptor.policy,
    ...(descriptor.policy === "TTL" ? { expiresAt: descriptor.expiresAt ?? at } : {})
  };
  return {
    specVersion: "premise/2",
    tenantId,
    memoryId: descriptor.id,
    evidence,
    confidence: { score: null, method: "efficiency-lab-v1", assessedAt: at },
    conflicts: [],
    temporal: { asOf: at },
    validity,
    dependsOn: descriptor.dependsOn,
    signatures: []
  };
}

function targetIdsFor(descriptors, options) {
  const known = new Set(descriptors.map(({ id }) => id));
  const dependents = new Set(descriptors.flatMap(({ dependsOn }) => dependsOn));
  const requested = options.targetIds ?? options.targets;
  const ids = requested === undefined
    ? descriptors.filter(({ id }) => !dependents.has(id)).map(({ id }) => id)
    : asArray(requested, "targetIds");
  if (ids.length === 0) throw new RangeError("targetIds must contain at least one memory ID");
  for (const id of ids) {
    if (!known.has(id)) throw new RangeError(`Unknown target ${id}`);
  }
  return unique(ids);
}

function sourceUriForNode(descriptors, id) {
  const descriptor = descriptors.find((item) => item.id === id);
  if (descriptor?.sourceUri !== undefined) return descriptor.sourceUri;
  return descriptor?.evidence?.[0]?.sourceUri;
}

function mutationInputs(options, descriptors, adapter) {
  const raw = options.mutations ?? options.mutation ?? options.changedSources;
  if (raw === null) return [];
  if (raw === undefined) {
    const first = descriptors.map(({ id }) => sourceUriForNode(descriptors, id)).find((sourceUri) => sourceUri !== undefined);
    return first === undefined ? [] : [{ sourceUri: first }];
  }
  const inputs = Array.isArray(raw) ? raw : [raw];
  return inputs.flatMap((input) => {
    if (typeof input === "string") return [{ sourceUri: input }];
    assertObject(input, "mutation");
    const ids = input.nodeIds ?? (input.nodeId === undefined ? undefined : [input.nodeId]);
    if (ids !== undefined) {
      return asArray(ids, "mutation.nodeIds").map((id) => ({
        ...input,
        sourceUri: input.sourceUri ?? sourceUriForNode(descriptors, id)
      }));
    }
    const sourceUris = input.sourceUris;
    if (sourceUris !== undefined) return asArray(sourceUris, "mutation.sourceUris").map((sourceUri) => ({ ...input, sourceUri }));
    return [input];
  }).map((input) => {
    const sourceUri = input.sourceUri ?? descriptors.map(({ id }) => sourceUriForNode(descriptors, id)).find((value) => value !== undefined);
    assertNonEmptyString(sourceUri, "mutation.sourceUri");
    if (!adapter.has(sourceUri)) throw new RangeError(`Unknown source ${sourceUri}`);
    return { ...input, sourceUri };
  });
}

function frontier(runtime, ids, enabled) {
  if (!enabled) return;
  for (const id of ids) runtime.frontier(id);
}

async function attemptAction(runtime, adapter, targetId, options) {
  const record = runtime.get(targetId);
  if (record === undefined) return { accepted: false, memoryId: targetId, reason: "MISSING" };
  const evidence = record.envelope.evidence[0];
  const expectedReference = options.expectedReference ?? evidence?.version;
  const expectedVersion = options.expectedVersion ?? expectedReference?.token;
  if (typeof expectedVersion !== "string") {
    return { accepted: false, memoryId: targetId, reason: "VERSION_MISMATCH" };
  }
  const sourceUri = evidence?.sourceUri;
  return runtime.revalidateAndAct(targetId, {
    expectedVersion,
    action: options.action,
    commit: async (_current, expected) => {
      if (sourceUri === undefined) return { accepted: true, result: options.action ?? null };
      const current = adapter.current(sourceUri);
      if (
        current === undefined
        || current.version.token !== expected
        || (expectedReference?.scheme !== undefined && current.version.scheme !== expectedReference.scheme)
      ) {
        return { accepted: false, reason: "VERSION_MISMATCH", observedVersion: current?.version.token };
      }
      return { accepted: true, result: options.action ?? null };
    }
  });
}

/**
 * Execute one physical v1 task against the built runtime-core package.
 * Only counters and recorder decisions cross the runner boundary.
 */
export async function runPhysicalTask(options = {}) {
  assertObject(options, "options");
  const at = normalizeNow(options.now);
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  assertNonEmptyString(tenantId, "tenantId");
  const descriptors = normalizeGraph(options);
  const recorder = new RuntimeInstrumentationRecorder();
  const adapter = new DeterministicMutableSourceAdapter({
    sources: options.sources,
    now: () => at,
    instrumentation: recorder
  });
  ensureSources(adapter, descriptors, options);
  const runtime = new PremiseRuntime({
    tenantId,
    now: () => at,
    instrumentation: recorder,
    incrementalFrontier: options.incrementalFrontier !== false
  });
  const evidenceById = new Map();
  for (const descriptor of descriptors) {
    const evidence = evidenceFor(descriptor, adapter, at);
    evidenceById.set(descriptor.id, evidence);
    const record = {
      envelope: envelopeFor(descriptor, evidence, tenantId, at),
      content: cloneJson(descriptor.content === undefined ? { memoryId: descriptor.id } : descriptor.content)
    };
    const eventId = `${descriptor.dependsOn.length === 0 ? "register" : "derive"}:${descriptor.id}`;
    if (descriptor.dependsOn.length === 0) runtime.register(record, eventId);
    else runtime.derive(record, eventId);
  }

  const targets = targetIdsFor(descriptors, options);
  const useFrontier = options.incrementalFrontier !== false;
  if (options.performAction !== true) {
    if (options.performAction !== true) {
      runtime.check(targets);
      frontier(runtime, targets, useFrontier);
    }
  }

  const changes = mutationInputs(options, descriptors, adapter).map((input) => adapter.mutate(input.sourceUri, input));
  let affected = [];
  if (changes.length > 0 && options.deliverEvents !== false) {
    affected = [...(changes.length === 1
      ? runtime.signalSourceChanged(changes[0].sourceUri, changes[0].version, changes[0].eventId)
      : runtime.signalSourcesChanged(changes))];
    if (options.performAction !== true) {
      runtime.check(targets);
      frontier(runtime, targets, useFrontier);
    }
  }

  const revalidate = options.revalidate !== false;
  const defaultRevalidationIds = affected
    .filter((id) => options.performAction !== true || targets.includes(id))
    .filter((id) => (evidenceById.get(id) ?? []).length > 0);
  const revalidationIds = options.revalidateIds === undefined
    ? defaultRevalidationIds
    : unique(asArray(options.revalidateIds, "revalidateIds"));
  if (revalidate && revalidationIds.length > 0) {
    await runtime.revalidateMany(revalidationIds, adapter.validator(), options.validationEventId);
  }
  if ((changes.length > 0 && options.deliverEvents !== false) || revalidationIds.length > 0) {
    if (options.performAction !== true) {
      runtime.check(targets);
      frontier(runtime, targets, useFrontier);
    }
  }

  const action = options.performAction === true && targets.length === 1
    ? await attemptAction(runtime, adapter, targets[0], options)
    : undefined;

  return Object.freeze({
    format: PHYSICAL_TRACE_FORMAT,
    counterSchema: PHYSICAL_COUNTER_SCHEMA,
    taskId: options.taskId ?? DEFAULT_TASK_ID,
    candidateId: options.candidateId ?? DEFAULT_CANDIDATE_ID,
    commit: options.commit ?? "UNKNOWN",
    counters: recorder.snapshot(),
    decisions: recorder.decisions(),
    ...(action === undefined ? {} : { action: cloneJson(action) }),
    status: "COMPLETE"
  });
}

export const runPhysicalScenario = runPhysicalTask;
export { DeterministicMutableSourceAdapter };

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(await runPhysicalTask(), null, 2)}\n`);
}
