import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ReferenceProtocol } from "../../packages/reference-ts/dist/index.js";

const OUTPUT = new URL("./results.json", import.meta.url);
const SPEC_VERSION = "premise/0.1";
const BASE_TIME = "2026-08-09T20:30:00Z";
const SOURCE_SCHEME = "bench.version";

function source(sourceUri, token, validator = "bench.validator") {
  return {
    sourceUri,
    observedAt: BASE_TIME,
    version: { scheme: SOURCE_SCHEME, token },
    validator: { id: validator, operation: "readVersion" }
  };
}

function envelope(memoryId, sourceUri, token, dependsOn = [], status = "FRESH") {
  return {
    specVersion: SPEC_VERSION,
    memoryId,
    provenance: [source(sourceUri, token)],
    validity: { status, checkedAt: BASE_TIME, policy: "VERSIONED" },
    dependsOn
  };
}

function scenarios() {
  const output = [];
  for (let index = 1; index <= 12; index += 1) output.push({ id: `repair-${String(index).padStart(2, "0")}`, kind: "repairable", result: "UNCHANGED", changed: true, dependsOn: index % 2 === 0 });
  for (let index = 1; index <= 6; index += 1) output.push({ id: `missing-${String(index).padStart(2, "0")}`, kind: "non-repairable", result: index % 2 === 0 ? "CHANGED" : "MISSING", changed: true, dependsOn: index % 2 === 0 });
  for (let index = 1; index <= 3; index += 1) output.push({ id: `unknown-${String(index).padStart(2, "0")}`, kind: "unknown", result: "UNKNOWN", changed: true, dependsOn: false });
  for (let index = 1; index <= 3; index += 1) output.push({ id: `fresh-${String(index).padStart(2, "0")}`, kind: "control", result: "UNCHANGED", changed: false, dependsOn: index === 3 });
  return output;
}

function validationResult(memoryId, result) {
  const status = result === "UNCHANGED" ? "FRESH" : result === "CHANGED" || result === "MISSING" ? "INVALID" : "UNKNOWN";
  return {
    memoryId,
    result,
    status,
    checkedAt: "2026-08-09T20:30:01Z",
    ...(result === "UNCHANGED" || result === "CHANGED" ? { version: { scheme: SOURCE_SCHEME, token: "v2" } } : {})
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function metrics(strategy, episodes) {
  const dynamic = episodes.filter((episode) => episode.kind !== "control");
  const repairable = episodes.filter((episode) => episode.kind === "repairable");
  const guarded = episodes.filter((episode) => episode.kind === "non-repairable" || episode.kind === "unknown");
  const controls = episodes.filter((episode) => episode.kind === "control");
  const durations = episodes.map((episode) => episode.durationMs);
  const memory = episodes.map((episode) => episode.memoryBytes);
  return {
    strategy,
    episodes: episodes.length,
    denominators: { dynamic: dynamic.length, repairable: repairable.length, guarded: guarded.length, controls: controls.length },
    unsafeActionRate: dynamic.length === 0 ? 0 : episodes.filter((episode) => episode.kind !== "control" && episode.decision === "USE" && !episode.safe).length / dynamic.length,
    recoveryRate: repairable.length === 0 ? 0 : repairable.filter((episode) => episode.repaired && episode.decision === "USE").length / repairable.length,
    nonRepairableRejectRate: guarded.filter((episode) => episode.kind === "non-repairable").length === 0 ? 0 : guarded.filter((episode) => episode.kind === "non-repairable" && episode.decision === "REJECT").length / guarded.filter((episode) => episode.kind === "non-repairable").length,
    revalidationCalls: episodes.reduce((sum, episode) => sum + episode.revalidationCalls, 0),
    readCalls: episodes.reduce((sum, episode) => sum + episode.readCalls, 0),
    latencyP50Ms: percentile(durations, 0.5),
    latencyP95Ms: percentile(durations, 0.95),
    memoryP50Bytes: percentile(memory, 0.5),
    memoryP95Bytes: percentile(memory, 0.95),
    historyPreservationRate: episodes.length === 0 ? 0 : episodes.filter((episode) => episode.historyPreserved).length / episodes.length,
    freshNonUseRate: controls.length === 0 ? 0 : controls.filter((episode) => episode.decision !== "USE").length / controls.length
  };
}

function baselineEpisode(scenario) {
  const started = performance.now();
  const decision = "USE";
  const safe = !scenario.changed;
  const durationMs = performance.now() - started;
  return {
    strategy: "No protocol",
    scenarioId: scenario.id,
    kind: scenario.kind,
    decision,
    safe,
    repaired: false,
    revalidationCalls: 0,
    readCalls: 1,
    historyPreserved: false,
    durationMs,
    memoryBytes: JSON.stringify({ memoryId: `memory:${scenario.id}` }).length,
    note: safe ? "fresh-memory-used" : "changed-memory-used-without-check"
  };
}

async function premiseEpisode(scenario) {
  const started = performance.now();
  const protocol = new ReferenceProtocol(() => BASE_TIME);
  const rootId = `memory:${scenario.id}:root`;
  const sourceUri = `bench://${scenario.id}`;
  protocol.register(envelope(rootId, sourceUri, "v1"));
  let targetId = rootId;
  if (scenario.dependsOn) {
    targetId = `memory:${scenario.id}:derived`;
    protocol.derive(envelope(targetId, `derived://${scenario.id}`, "derived-v1", [rootId]));
  }
  if (scenario.changed) {
    protocol.signal({
      specVersion: SPEC_VERSION,
      eventId: `change:${scenario.id}`,
      type: "SourceChanged",
      occurredAt: "2026-08-09T20:30:01Z",
      payload: { sourceUri, version: { scheme: SOURCE_SCHEME, token: "v2" } }
    });
    await protocol.validate([rootId], { [rootId]: validationResult(rootId, scenario.result) });
  }
  const check = protocol.check([targetId]).items[0];
  const decision = check?.decision === "USABLE" ? "USE" : check?.decision === "REJECT" ? "REJECT" : "REVALIDATE";
  const repaired = scenario.kind === "repairable" && decision === "USE";
  const safe = !scenario.changed || decision !== "USE" || repaired;
  const history = protocol.history(targetId);
  const durationMs = performance.now() - started;
  return {
    strategy: "PREMiSE",
    scenarioId: scenario.id,
    kind: scenario.kind,
    decision,
    safe,
    repaired,
    revalidationCalls: scenario.changed ? 1 : 0,
    readCalls: 1 + (scenario.changed ? 1 : 0),
    historyPreserved: history.length > 0,
    durationMs,
    memoryBytes: JSON.stringify({ envelope: protocol.states.stateOf(targetId)?.envelope, history }).length,
    status: check?.status ?? "UNKNOWN"
  };
}

export async function run() {
  const definitions = scenarios();
  const baseline = definitions.map(baselineEpisode);
  const premise = [];
  for (const definition of definitions) premise.push(await premiseEpisode(definition));
  const result = {
    format: "premise-comparative-benchmark/0.1",
    suite: "paired-validity-v0.2",
    runner: "node24",
    seed: "premise-comparative-2026-08-09",
    scenarios: definitions,
    pairedMetrics: [metrics("No protocol", baseline), metrics("PREMiSE", premise)],
    perEpisode: [...baseline, ...premise],
    limitations: [
      "The baseline intentionally represents use-without-revalidation, not a full memory product.",
      "Memory bytes are serialized metadata bytes, not process-wide heap attribution.",
      "Latency is local deterministic runtime latency and is not a production SLA."
    ]
  };
  await mkdir(new URL(".", OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ format: result.format, scenarios: definitions.length, metrics: result.pairedMetrics }, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
