import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const RUNTIME_ENTRY = resolve(ROOT, "packages/runtime-core/dist/index.js");
const ORACLE_ENTRY = fileURLToPath(new URL("./bounded-oracle.mjs", import.meta.url));
const OUTPUT_DIRECTORY = resolve(ROOT, ".tmp", "premise-efficiency-lab", "v1", "horizon");
const AT = "2026-08-13T00:00:00.000Z";
const FORMAT = "premise-efficiency-lab/bounded-runtime/v1";

function parseList(value, fallback) {
  const list = value === undefined ? fallback : value.split(",").map((item) => Number(item));
  if (list.length === 0 || list.some((item) => !Number.isSafeInteger(item) || item < 1)) throw new RangeError("campaign lists must contain positive safe integers");
  return list;
}

function parseArgs() {
  const horizons = parseList(process.argv.find((item) => item.startsWith("--horizons="))?.slice(11), [1000, 10000]);
  const worldSizes = parseList(process.argv.find((item) => item.startsWith("--world-sizes="))?.slice(14), [8]);
  const tailSize = Number(process.argv.find((item) => item.startsWith("--tail-size="))?.slice(12) ?? 256);
  const checkpointEvery = Number(process.argv.find((item) => item.startsWith("--checkpoint-every="))?.slice(19) ?? 10_000);
  if (!Number.isSafeInteger(tailSize) || tailSize < 1) throw new RangeError("tail-size must be a positive safe integer");
  if (!Number.isSafeInteger(checkpointEvery) || checkpointEvery < 1) throw new RangeError("checkpoint-every must be a positive safe integer");
  return { horizons, worldSizes, tailSize, checkpointEvery };
}

function gitMetadata() {
  const runGit = (args, fallback) => {
    try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return fallback; }
  };
  return Object.freeze({ commit: runGit(["rev-parse", "HEAD"], "unknown"), dirty: runGit(["status", "--porcelain", "--untracked-files=no"], "unknown") !== "", node: process.version, platform: process.platform, arch: process.arch });
}

function activeEnvelope(memoryId, dependsOn) {
  return {
    specVersion: "premise/2",
    tenantId: "tenant:bounded",
    memoryId,
    evidence: dependsOn.length === 0 ? [{ evidenceId: `${memoryId}:e`, sourceUri: "source://bounded", observedAt: AT, version: { scheme: "counter", token: "v0" }, validator: { id: "bounded", operation: "read" } }] : [],
    confidence: { score: null, method: "bounded-runtime", assessedAt: AT },
    conflicts: [],
    temporal: { asOf: AT },
    validity: { status: "FRESH", checkedAt: AT, policy: "MANUAL" },
    dependsOn,
    signatures: []
  };
}

function sourceEvent(step) {
  const hex = step.toString(16).padStart(64, "0").slice(-64);
  return {
    specVersion: "premise/2",
    tenantId: "tenant:bounded",
    eventId: `event:bounded:${step}`,
    operationId: `operation:bounded:${step}`,
    idempotencyKey: `idempotency:bounded:${step}`,
    requestDigest: `sha256:${hex}`,
    type: "SourceChanged",
    occurredAt: AT,
    payload: { sourceUri: "source://bounded", version: { scheme: "counter", token: `v${step}` } }
  };
}

function compactState(module, store, journal, worldSize, tailSize, step) {
  const { createRuntimeCheckpoint, journalCheckpointDigest, runtimeIdempotencyState } = module;
  const latest = journal.latestCursor();
  const checkpointCursor = Math.max(0, latest - tailSize);
  const tail = journal.readFrom(checkpointCursor).filter((entry) => entry.kind === "event");
  const tailEvents = tail.map((entry) => entry.event);
  const checkpoint = createRuntimeCheckpoint({
    format: "premise-runtime-checkpoint",
    version: 1,
    capturedAt: AT,
    activeRecords: store.list(),
    frontierState: { active: worldSize, status: "TRUSTED" },
    incarnations: { world: "bounded-v1" },
    eventCursor: checkpointCursor,
    receiptEpoch: step,
    idempotencyState: runtimeIdempotencyState(tailEvents),
    sourceVersions: { "source://bounded": `v${step}` },
    dependencyState: { worldSize }
  });
  journal.checkpoint({ checkpointId: `checkpoint:${step}`, cursor: checkpointCursor, digest: journalCheckpointDigest(checkpoint), state: checkpoint });
  store.compactOperational(checkpoint, tail);
  return { checkpointCursor, tail: tail.length };
}

function oracle(input) {
  const evidenceDigest = `sha256:${createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;
  try {
    const result = JSON.parse(execFileSync(process.execPath, [ORACLE_ENTRY], { cwd: ROOT, input: JSON.stringify(input), encoding: "utf8" }));
    return Object.freeze({ ...result, evidenceDigest });
  } catch {
    return Object.freeze({ pass: false, evidenceDigest });
  }
}

async function runCase(module, { steps, worldSize, tailSize, checkpointEvery }) {
  const { InMemoryJournal, InMemoryRuntimeStore } = module;
  const store = new InMemoryRuntimeStore();
  const journal = new InMemoryJournal();
  for (let index = 0; index < worldSize; index += 1) {
    const memoryId = `memory:active:${index}`;
    store.put({ envelope: activeEnvelope(memoryId, index === 0 ? [] : [`memory:active:${index - 1}`]), content: { index } });
  }
  const samples = [];
  let errors = 0;
  let checkpoints = 0;
  for (let step = 1; step <= steps; step += 1) {
    try {
      const event = sourceEvent(step);
      store.appendEvent(event);
      journal.appendEvent(event);
      if (step % checkpointEvery === 0 || step === steps) {
        compactState(module, store, journal, worldSize, tailSize, step);
        checkpoints += 1;
        const stats = store.operationalStats();
        samples.push({ step, ...stats, auditEntries: journal.latestCursor() });
      }
    } catch {
      errors += 1;
    }
  }
  const stats = store.operationalStats();
  const observed = {
    records: stats.records,
    finalEventTail: stats.eventTail,
    finalIdempotencyKeys: stats.idempotencyKeys,
    peakEventTail: Math.max(...samples.map((sample) => sample.eventTail), 0),
    peakIdempotencyKeys: Math.max(...samples.map((sample) => sample.idempotencyKeys), 0),
    auditEntries: journal.latestCursor(),
    checkpoints,
    errors
  };
  const evidence = oracle({ steps, worldSize, tailSize, observed });
  return Object.freeze({ steps, worldSize, tailSize, checkpointEvery, observed: Object.freeze(observed), samples: Object.freeze(samples), oracle: evidence, fullReplayProtection: steps <= tailSize });
}

export async function runBoundedRuntimeCampaign({ horizons = [1000, 10000], worldSizes = [8], tailSize = 256, checkpointEvery = 10_000 } = {}) {
  const module = await import(pathToFileURL(RUNTIME_ENTRY).href);
  const rows = [];
  for (const steps of horizons) {
    for (const worldSize of worldSizes) rows.push(await runCase(module, { steps, worldSize, tailSize, checkpointEvery }));
  }
  const boundedOperationalState = rows.every((row) => row.oracle.pass === true);
  const fullReplayProtection = rows.every((row) => row.fullReplayProtection === true);
  const unsigned = {
    format: FORMAT,
    status: boundedOperationalState && fullReplayProtection ? "PASS" : "INCONCLUSIVE",
    boundedOperationalState,
    fullReplayProtection,
    claims: { measurementOnly: true, boundedOperationalState, fullReplayProtection, durableAudit: true, enterpriseScale: false, commercialClaim: false },
    metadata: { ...gitMetadata(), config: { horizons: [...horizons], worldSizes: [...worldSizes], tailSize, checkpointEvery } },
    rows
  };
  const artifactDigest = `sha256:${createHash("sha256").update(JSON.stringify(unsigned), "utf8").digest("hex")}`;
  const result = Object.freeze({ ...unsigned, artifactDigest });
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(resolve(OUTPUT_DIRECTORY, "bounded-runtime.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const result = await runBoundedRuntimeCampaign(parseArgs());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "PASS") process.exitCode = 1;
}
