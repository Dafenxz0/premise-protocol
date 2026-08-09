import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ReferenceProtocol } from "../../packages/reference-ts/dist/index.js";

const OUTPUT = new URL("./results.json", import.meta.url);
const SPEC_VERSION = "premise/0.1";
const BASE_TIME = "2026-08-09T20:40:00Z";
const SOURCE_SCHEME = "long-context.version";
const DEFAULT_PROFILES = [1000, 5000];

function args(argv) {
  const options = { profiles: DEFAULT_PROFILES, maxMs: 120000, full: false, payloadBytes: 65536 };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--full") options.full = true;
    else if (value === "--profiles") options.profiles = String(argv[++index]).split(",").map(Number).filter((count) => Number.isInteger(count) && count > 0);
    else if (value === "--max-ms") options.maxMs = Number(argv[++index]);
    else if (value === "--payload-bytes") options.payloadBytes = Number(argv[++index]);
  }
  if (options.full) options.profiles = [...new Set([...options.profiles, 10000, 25000])].sort((a, b) => a - b);
  return options;
}

function source(sourceUri, token) {
  return {
    sourceUri,
    observedAt: BASE_TIME,
    version: { scheme: SOURCE_SCHEME, token },
    validator: { id: "long-context.validator", operation: "readVersion" }
  };
}

function envelope(memoryId, sourceUri, token, dependsOn = []) {
  return {
    specVersion: SPEC_VERSION,
    memoryId,
    provenance: [source(sourceUri, token)],
    validity: { status: "FRESH", checkedAt: BASE_TIME, policy: "VERSIONED" },
    dependsOn
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function checkDeadline(deadline, label) {
  if (Date.now() > deadline) throw new Error(`${label} exceeded max-ms`);
}

function dependenciesFor(index, topology) {
  if (index === 0) return [];
  if (topology === "chain") return [`memory:${topology}:${index - 1}`];
  if (topology === "fanout") return ["memory:fanout:root"];
  return index % 2 === 0 ? ["memory:shared:root-a", "memory:shared:root-b"] : ["memory:shared:root-a"];
}

function sourceFor(index, topology) {
  if (topology === "fanout") return index === 0 ? "long://fanout/root" : `derived://fanout/${index}`;
  if (topology === "shared") return index === 0 ? "long://shared/root-a" : index === 1 ? "long://shared/root-b" : `derived://shared/${index}`;
  return index === 0 ? "long://chain/root" : `derived://chain/${index}`;
}

async function runProfile(count, topology, options) {
  const startedAt = performance.now();
  const deadline = Date.now() + options.maxMs;
  const beforeHeap = process.memoryUsage().heapUsed;
  const protocol = new ReferenceProtocol(() => BASE_TIME);
  const registerSamples = [];
  const deriveSamples = [];
  const envelopes = [];
  const rootIds = topology === "fanout" ? ["memory:fanout:root"] : topology === "shared" ? ["memory:shared:root-a", "memory:shared:root-b"] : ["memory:chain:0"];
  const nodeCount = topology === "shared" ? Math.max(count, 2) : count;
  let metadataBytes = 0;

  for (let index = 0; index < nodeCount; index += 1) {
    const memoryId = topology === "fanout" ? index === 0 ? "memory:fanout:root" : `memory:fanout:${index}` : topology === "shared" ? index === 0 ? "memory:shared:root-a" : index === 1 ? "memory:shared:root-b" : `memory:shared:${index}` : `memory:chain:${index}`;
    const sourceUri = sourceFor(index, topology);
    const dependencyIds = dependenciesFor(index, topology);
    const value = envelope(memoryId, sourceUri, "v1", dependencyIds);
    envelopes.push(value);
    metadataBytes += JSON.stringify(value).length;
    const operationStarted = performance.now();
    if (dependencyIds.length === 0) protocol.register(value);
    else protocol.derive(value);
    const operationDuration = performance.now() - operationStarted;
    if (dependencyIds.length === 0) registerSamples.push(operationDuration);
    else deriveSamples.push(operationDuration);
    if (index % 250 === 0) checkDeadline(deadline, `${topology} build`);
  }

  const targetId = envelopes[envelopes.length - 1].memoryId;
  const checkStarted = performance.now();
  const beforeChange = protocol.check([targetId]).items[0];
  const checkMs = performance.now() - checkStarted;

  const signalStarted = performance.now();
  const signalSource = sourceFor(0, topology);
  const signalResult = protocol.signal({
    specVersion: SPEC_VERSION,
    eventId: `long-signal:${topology}:${count}`,
    type: "SourceChanged",
    occurredAt: "2026-08-09T20:40:01Z",
    payload: { sourceUri: signalSource, version: { scheme: SOURCE_SCHEME, token: "v2" } }
  });
  const signalMs = performance.now() - signalStarted;
  const afterSignalStatus = protocol.states.stateOf(targetId)?.status ?? "UNKNOWN";

  const validateStarted = performance.now();
  const rootId = rootIds[0];
  await protocol.validate([rootId], {
    [rootId]: { memoryId: rootId, result: "UNCHANGED", status: "FRESH", checkedAt: "2026-08-09T20:40:02Z", version: { scheme: SOURCE_SCHEME, token: "v2" } }
  });
  const validateMs = performance.now() - validateStarted;
  const afterChange = protocol.check([targetId]).items[0];
  const afterHeap = process.memoryUsage().heapUsed;
  checkDeadline(deadline, `${topology} profile`);
  const operationSamples = [...registerSamples, ...deriveSamples, checkMs, signalMs, validateMs];
  return {
    strategy: `PREMiSE:${topology}:${count}`,
    count,
    topology,
    nodes: nodeCount,
    seed: `long-context-${topology}-${count}`,
    registerMs: registerSamples.reduce((sum, value) => sum + value, 0),
    deriveMs: deriveSamples.reduce((sum, value) => sum + value, 0),
    checkMs,
    signalMs,
    validateMs,
    registerP50Ms: percentile(registerSamples, 0.5),
    registerP95Ms: percentile(registerSamples, 0.95),
    deriveP50Ms: percentile(deriveSamples, 0.5),
    deriveP95Ms: percentile(deriveSamples, 0.95),
    latencyP50Ms: percentile(operationSamples, 0.5),
    latencyP95Ms: percentile(operationSamples, 0.95),
    heapDeltaBytes: Math.max(0, afterHeap - beforeHeap),
    serializedMetadataBytes: metadataBytes,
    externalPayloadBytes: options.payloadBytes,
    externalPayloadStoredInProtocol: false,
    beforeChangeStatus: beforeChange.status,
    afterSignalStatus,
    afterValidateStatus: afterChange.status,
    affectedNodes: signalResult.affected.length,
    historyLength: protocol.history(targetId).length,
    totalMs: performance.now() - startedAt
  };
}

async function isolationCheck() {
  const protocol = new ReferenceProtocol(() => BASE_TIME);
  protocol.register(envelope("memory:isolation:a", "long://isolation/a", "v1"));
  protocol.register(envelope("memory:isolation:b", "long://isolation/b", "v1"));
  protocol.derive(envelope("memory:isolation:dependent", "derived://isolation/dependent", "v1", ["memory:isolation:a"]));
  const report = protocol.signal({
    specVersion: SPEC_VERSION,
    eventId: "long-isolation-signal",
    type: "SourceChanged",
    occurredAt: "2026-08-09T20:40:01Z",
    payload: { sourceUri: "long://isolation/a", version: { scheme: SOURCE_SCHEME, token: "v2" } }
  });
  return {
    passed: report.affected.includes("memory:isolation:a") && report.affected.includes("memory:isolation:dependent") && !report.affected.includes("memory:isolation:b") && protocol.check(["memory:isolation:b"]).items[0].status === "FRESH",
    affected: report.affected
  };
}

export async function run(options = args(process.argv)) {
  const profiles = [];
  for (const count of options.profiles) {
    for (const topology of ["chain", "fanout", "shared"]) profiles.push(await runProfile(count, topology, options));
  }
  const result = {
    format: "premise-long-context-benchmark/0.1",
    runner: "node24",
    profiles: options.profiles,
    maxMs: options.maxMs,
    payloadBytes: options.payloadBytes,
    results: profiles,
    invariants: { isolation: await isolationCheck(), topologyCount: new Set(profiles.map((profile) => profile.topology)).size },
    limitations: [
      "heapDeltaBytes is process-level sampled heap, not an isolated allocation profile.",
      "externalPayloadBytes describes content held outside PREMiSE; the runner deliberately does not store that content in envelopes.",
      "Profiles are local Node 24 measurements and should be repeated on the target deployment hardware."
    ]
  };
  await mkdir(new URL(".", OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ format: result.format, profiles: profiles.length, results: profiles.map(({ count, topology, nodes, totalMs, heapDeltaBytes }) => ({ count, topology, nodes, totalMs, heapDeltaBytes })), invariants: result.invariants }, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
