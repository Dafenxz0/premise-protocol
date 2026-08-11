import { createHash } from "node:crypto";

export const FORMAT = "premisebench-agent/scientific-adversarial/v1";
export const MUTATION_KINDS = Object.freeze([
  "rename",
  "delete-recreate",
  "aba",
  "partial-write",
  "lost-event",
  "duplicate-event",
  "out-of-order-event",
  "timeout",
  "lying-validator",
  "cas-conflict",
  "dependency-fan-out",
  "cycle-attempt",
  "clock-skew",
  "disappearing-source",
  "concurrent-writers",
  "partition",
  "toctou"
]);
export const SCENARIO_KINDS = MUTATION_KINDS;
export const scenarioTypes = SCENARIO_KINDS;

const DEFAULT_COUNT = 32;
const DEFAULT_SEED = "scientific-mvp";
const FORBIDDEN = /^(?:label|labels|mutation|mutations|oracle|groundTruth|expected|outcome|objective)$/iu;

function canonical(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function copy(value) {
  return JSON.parse(canonical(value));
}

function digest(...parts) {
  return createHash("sha256").update(parts.map(canonical).join("\u001f"), "utf8").digest("hex");
}

export function hashValue(value) {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

export function normalizeSeed(seed = DEFAULT_SEED) {
  if (typeof seed === "number") {
    if (!Number.isSafeInteger(seed)) throw new TypeError("seed must be a safe integer or non-empty string");
    return String(seed);
  }
  if (typeof seed === "bigint") return seed.toString();
  if (typeof seed === "string" && seed.trim() !== "") return seed.trim();
  throw new TypeError("seed must be a safe integer or non-empty string");
}

export function deriveSeed(seed, index = 0) {
  assertIndex(index);
  return `sha256:${digest("scientific-seed", normalizeSeed(seed), index)}`;
}

function numberFor(...parts) {
  return Number.parseInt(digest(...parts).slice(0, 8), 16) >>> 0;
}

function choose(values, ...parts) {
  return values[numberFor(...parts) % values.length];
}

function assertIndex(index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("scenario index must be a non-negative safe integer");
}

function assertCount(count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("count must be a positive safe integer");
}

function publicSeed(seed) {
  return typeof seed === "number" ? seed : normalizeSeed(seed);
}

function resolveOptions(value, seed) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const listed = Array.isArray(value.tasks) ? value.tasks.length : Array.isArray(value.scenarios) ? value.scenarios.length : undefined;
    return {
      count: value.count ?? listed ?? value.tasks ?? value.size ?? DEFAULT_COUNT,
      seed: value.seed ?? DEFAULT_SEED
    };
  }
  return { count: value ?? DEFAULT_COUNT, seed: seed ?? DEFAULT_SEED };
}

function resolveScenarioArgs(index, seed) {
  if (index && typeof index === "object" && !Array.isArray(index)) {
    return { index: index.index ?? 0, seed: index.seed ?? DEFAULT_SEED };
  }
  if (typeof index === "string" && seed === undefined) return { index: 0, seed: index };
  return { index: index ?? 0, seed: seed ?? DEFAULT_SEED };
}

function snapshot(source, version, content) {
  return { source, version, content: copy(content) };
}

function event(rootSeed, index, kind, type, at, payload) {
  return {
    id: `event-${digest(rootSeed, index, kind, type, at).slice(0, 12)}`,
    type,
    at,
    payload: copy(payload)
  };
}

function buildMutation(kind, context) {
  const {
    rootSeed, index, source, renamedSource, initial, next, initialVersion, nextVersion, baseTime
  } = context;
  const before = snapshot(source, initialVersion, initial);
  const after = snapshot(source, nextVersion, next);
  const makeEvent = (type, at, payload) => event(rootSeed, index, kind, type, at, payload);
  const base = { kind, type: kind, phase: "before-action", initial: before, final: after, events: [] };

  switch (kind) {
    case "rename":
      return {
        ...base,
        events: [makeEvent("rename", baseTime + 10, { from: source, to: renamedSource })],
        final: snapshot(renamedSource, nextVersion, next)
      };
    case "delete-recreate":
      return {
        ...base,
        events: [
          makeEvent("delete", baseTime + 10, { source }),
          makeEvent("recreate", baseTime + 20, { source, generation: 2 })
        ],
        final: snapshot(source, nextVersion, { ...next, generation: 2 }),
        generations: [1, 2]
      };
    case "aba": {
      const middleVersion = `v2-${digest(rootSeed, index, "aba-middle").slice(0, 10)}`;
      const finalVersion = `v3-${digest(rootSeed, index, "aba-final").slice(0, 10)}`;
      const middle = { ...initial, value: `transient-${digest(rootSeed, index, "aba").slice(0, 10)}`, revision: 2 };
      const restored = { ...initial, revision: 3 };
      return {
        ...base,
        events: [
          makeEvent("write", baseTime + 10, { version: middleVersion, content: middle }),
          makeEvent("write", baseTime + 20, { version: finalVersion, content: restored })
        ],
        final: snapshot(source, finalVersion, restored),
        versions: [initialVersion, middleVersion, finalVersion],
        sameContentAtEnd: true
      };
    }
    case "partial-write": {
      const partial = { status: "active", revision: 2 };
      return {
        ...base,
        events: [makeEvent("partial-write", baseTime + 10, { written: ["status", "revision"], missing: ["value", "checksum"] })],
        final: snapshot(source, nextVersion, partial),
        complete: false
      };
    }
    case "lost-event": {
      const update = makeEvent("update", baseTime + 10, { from: initialVersion, to: nextVersion });
      return { ...base, events: [update], delivery: "lost", delivered: [] };
    }
    case "duplicate-event": {
      const update = makeEvent("update", baseTime + 10, { from: initialVersion, to: nextVersion });
      return { ...base, events: [update], delivery: "duplicate", delivered: [copy(update), copy(update)] };
    }
    case "out-of-order-event": {
      const first = makeEvent("update", baseTime + 10, { sequence: 1, version: nextVersion });
      const second = makeEvent("update", baseTime + 20, { sequence: 2, version: `${nextVersion}-2` });
      return { ...base, events: [first, second], delivery: "out-of-order", delivered: [copy(second), copy(first)] };
    }
    case "timeout":
      return {
        ...base,
        events: [makeEvent("request", baseTime + 10, { source }), makeEvent("timeout", baseTime + 10 + 25, { timeoutMs: 25 })],
        transport: { status: "timeout", timeoutMs: 25 }
      };
    case "lying-validator":
      return {
        ...base,
        events: [makeEvent("validation", baseTime + 10, { reported: "valid", checksumMatches: false })],
        validator: { report: "valid", checksPassed: false, checksum: "mismatch" }
      };
    case "cas-conflict":
      return {
        ...base,
        events: [makeEvent("writer", baseTime + 10, { writer: "external", version: nextVersion })],
        compareAndSet: { expectedVersion: initialVersion, currentVersion: nextVersion, accepted: false },
        conflict: true
      };
    case "dependency-fan-out": {
      const fanOut = 2 + (numberFor(rootSeed, index, "fan-out") % 3);
      const dependents = Array.from({ length: fanOut }, (_, position) => `${source}/dependent-${position + 1}`);
      return {
        ...base,
        events: [makeEvent("dependency-update", baseTime + 10, { source, dependents })],
        graph: { nodes: [source, ...dependents], edges: dependents.map((node) => [source, node]) },
        fanOut
      };
    }
    case "cycle-attempt": {
      const nodes = [source, `${source}/dependency-a`, `${source}/dependency-b`];
      return {
        ...base,
        events: [makeEvent("cycle-attempt", baseTime + 10, { nodes })],
        graph: { nodes, edges: [[nodes[0], nodes[1]], [nodes[1], nodes[2]], [nodes[2], nodes[0]]] },
        accepted: false
      };
    }
    case "clock-skew": {
      const offsetMs = choose([-90000, -30000, 30000, 90000], rootSeed, index, "clock-skew");
      return {
        ...base,
        events: [makeEvent("clock-read", baseTime + 10, { sourceTime: baseTime, localTime: baseTime + offsetMs })],
        clock: { offsetMs, sourceTime: baseTime, localTime: baseTime + offsetMs }
      };
    }
    case "disappearing-source":
      return {
        ...base,
        events: [makeEvent("remove-source", baseTime + 10, { source })],
        final: null,
        available: false
      };
    case "concurrent-writers": {
      const writerCount = choose([2, 3], rootSeed, index, "writers");
      const writers = Array.from({ length: writerCount }, (_, position) => ({
        id: `writer-${position + 1}`,
        baseVersion: initialVersion,
        version: `${nextVersion}-${position + 1}`
      }));
      return {
        ...base,
        events: writers.map((writer, position) => makeEvent("concurrent-write", baseTime + 10 + position, writer)),
        writers,
        writerCount,
        winner: writers[writerCount - 1].id
      };
    }
    case "partition":
      return {
        ...base,
        events: [makeEvent("partition", baseTime + 10, { left: source, right: `${source}/replica` })],
        links: { primary: "available", replica: "partitioned" },
        delivered: false
      };
    case "toctou":
      return {
        ...base,
        phase: "during-write",
        events: [
          makeEvent("check", baseTime + 10, { version: initialVersion }),
          makeEvent("intervening-write", baseTime + 20, { version: nextVersion }),
          makeEvent("write", baseTime + 30, { version: nextVersion })
        ],
        window: "check-to-write",
        compareAndSet: { expectedVersion: initialVersion, currentVersion: nextVersion, accepted: false }
      };
    default:
      throw new Error(`unknown scenario kind: ${kind}`);
  }
}

function makeScenario(index, seed) {
  assertIndex(index);
  const rootSeed = normalizeSeed(seed);
  const scenarioSeed = deriveSeed(rootSeed, index);
  const shortSeed = scenarioSeed.slice(7, 19);
  const kind = MUTATION_KINDS[(index + numberFor(rootSeed, "kind")) % MUTATION_KINDS.length];
  const sourceToken = digest(rootSeed, index, "source").slice(0, 14);
  const source = `source://${sourceToken}`;
  const renamedSource = `${source}/renamed`;
  const baseTime = 1700000000000 + (numberFor(rootSeed, index, "time") % 1000000000);
  const initialVersion = `v1-${digest(rootSeed, index, "version-a").slice(0, 10)}`;
  const nextVersion = `v2-${digest(rootSeed, index, "version-b").slice(0, 10)}`;
  const initial = {
    status: "active",
    value: `value-${digest(rootSeed, index, "value-a").slice(0, 12)}`,
    revision: 1,
    checksum: digest(rootSeed, index, "checksum-a").slice(0, 16)
  };
  const next = {
    status: "active",
    value: `value-${digest(rootSeed, index, "value-b").slice(0, 12)}`,
    revision: 2,
    checksum: digest(rootSeed, index, "checksum-b").slice(0, 16)
  };
  const taskId = `scientific-${shortSeed}-${String(index + 1).padStart(4, "0")}`;
  const agentInput = {
    taskId,
    prompt: "Assess whether the observed record is safe to apply; verify current state before committing.",
    source,
    memory: { content: copy(initial), version: initialVersion, observedAt: baseTime }
  };
  const mutation = buildMutation(kind, {
    rootSeed, index, source, renamedSource, initial, next, initialVersion, nextVersion, baseTime
  });
  const evaluator = {
    terminal: mutation.final?.content?.status === "active" ? "guarded-apply" : "reject",
    finalVersion: mutation.final?.version ?? null,
    eventCount: mutation.events.length
  };
  return { format: FORMAT, taskId, index, seed: scenarioSeed, agentInput, mutation, evaluator };
}

export function generateScenario(index = 0, seed) {
  const args = resolveScenarioArgs(index, seed);
  return makeScenario(args.index, args.seed);
}

export const makeScenarioForScientific = generateScenario;

export function generateScenarios(value = DEFAULT_COUNT, seed) {
  const options = resolveOptions(value, seed);
  assertCount(options.count);
  normalizeSeed(options.seed);
  return Array.from({ length: options.count }, (_, index) => makeScenario(index, options.seed));
}

export const makeScenarios = generateScenarios;

function scenarioList(value) {
  if (Array.isArray(value)) return value;
  if (value?.publicManifest?.tasks) return value.publicManifest.tasks;
  if (value?.scenarios) return value.scenarios;
  if (value?.tasks) return value.tasks;
  if (value?.tasks === undefined && value?.agentInput) return [value];
  throw new TypeError("expected scenarios, tasks, or a generated dataset");
}

export function toAgentInput(scenario) {
  const input = scenario?.agentInput ?? scenario;
  const result = {
    taskId: input?.taskId,
    prompt: input?.prompt,
    source: input?.source,
    memory: input?.memory
  };
  if (typeof result.taskId !== "string" || typeof result.prompt !== "string" || typeof result.source !== "string" || !result.memory) {
    throw new TypeError("scenario is missing the public agent input");
  }
  assertPublic(result);
  return copy(result);
}

export const projectAgentInput = toAgentInput;

function assertPublic(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublic(item, `${path}[${index}]`));
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.test(key)) throw new Error(`private evaluator field ${path}.${key} crossed the agent boundary`);
    assertPublic(child, `${path}.${key}`);
  }
  return value;
}

export function hashDataset(value) {
  const tasks = scenarioList(value).map(toAgentInput);
  return hashValue({ format: "scientific-public-dataset/v1", tasks });
}

export const datasetHash = hashDataset;
export const getDatasetHash = hashDataset;

export function createPublicManifest(value, options = {}) {
  const tasks = scenarioList(value).map(toAgentInput);
  const source = value && !Array.isArray(value) ? value : {};
  const seed = options.seed ?? source.seed ?? null;
  const manifest = {
    format: `${FORMAT}/public`,
    seed: seed === null ? null : publicSeed(seed),
    taskCount: tasks.length,
    datasetHash: hashDataset(tasks),
    hashAlgorithm: "sha256",
    tasks
  };
  assertPublic(manifest);
  return manifest;
}

export const makePublicManifest = createPublicManifest;
export const publicManifest = createPublicManifest;

export function generateDataset(value = DEFAULT_COUNT, seed) {
  const options = resolveOptions(value, seed);
  assertCount(options.count);
  const rootSeed = normalizeSeed(options.seed);
  const scenarios = generateScenarios(options.count, rootSeed);
  const tasks = scenarios.map(toAgentInput);
  const manifest = createPublicManifest({ seed: publicSeed(options.seed), scenarios });
  return {
    format: FORMAT,
    seed: publicSeed(options.seed),
    taskCount: scenarios.length,
    scenarios,
    tasks,
    datasetHash: manifest.datasetHash,
    hash: manifest.datasetHash,
    publicManifest: manifest
  };
}

export const makeDataset = generateDataset;
export const createDataset = generateDataset;

export function runMetamorphicChecks(value = {}) {
  const options = value && typeof value === "object" && !Array.isArray(value) && (value.seed !== undefined || value.count !== undefined || value.tasks !== undefined)
    ? resolveOptions(value)
    : { count: DEFAULT_COUNT, seed: DEFAULT_SEED };
  assertCount(options.count);
  const rootSeed = normalizeSeed(options.seed);
  const first = generateScenarios(options.count, rootSeed);
  const second = generateScenarios(options.count, rootSeed);
  const larger = generateScenarios(options.count + 1, rootSeed);
  const otherSeed = `${rootSeed}:other`;
  const firstHash = hashDataset(first);
  const checks = {
    deterministic: firstHash === hashDataset(second),
    prefix: firstHash === hashDataset(larger.slice(0, options.count)),
    seedSensitivity: firstHash !== hashDataset(generateScenarios(options.count, otherSeed)),
    publicBoundary: first.every((scenario) => {
      try {
        assertPublic(toAgentInput(scenario));
        return true;
      } catch {
        return false;
      }
    }),
    uniqueTaskIds: new Set(first.map((scenario) => scenario.taskId)).size === first.length,
    kindCoverage: options.count < MUTATION_KINDS.length || new Set(first.map((scenario) => scenario.mutation.kind)).size === MUTATION_KINDS.length
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    failures: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
    datasetHash: firstHash
  };
}

export const metamorphicChecks = runMetamorphicChecks;

export function assertMetamorphicChecks(value = {}) {
  const result = runMetamorphicChecks(value);
  if (!result.ok) throw new Error(`metamorphic checks failed: ${result.failures.join(", ")}`);
  return result;
}

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((item) => item.startsWith(prefix));
  return match === undefined ? fallback : match.slice(prefix.length);
}

if (/(?:^|[\\/])scientific[\\/]adversarial\.mjs$/u.test(process.argv[1] ?? "")) {
  const count = Number(argument("count", argument("tasks", String(DEFAULT_COUNT))));
  const seed = argument("seed", DEFAULT_SEED);
  console.log(JSON.stringify(generateDataset({ count, seed }).publicManifest, null, 2));
}
