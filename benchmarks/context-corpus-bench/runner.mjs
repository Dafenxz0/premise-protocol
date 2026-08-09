import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ReferenceProtocol } from "../../packages/reference-ts/dist/index.js";
import { FilesystemValidator } from "../../packages/validator-filesystem/dist/index.js";

const OUTPUT = new URL("./results.json", import.meta.url);
const SPEC_VERSION = "premise/0.1";
const BASE_TIME = "2026-08-09T22:00:00Z";
const REPAIR_TIME = "2026-08-09T22:00:02Z";
const DEFAULT_PROFILES = [1000, 10000, 50000];
const PATTERNS = ["chain", "fanout", "shared"];
const TOP_K = 10;
const BATCH_SIZE = 128;
const BODY_MARKER = "external-body-marker";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function checkDeadline(deadline, label) {
  if (Date.now() > deadline) throw new Error(`${label} exceeded --max-ms`);
}

function parseProfiles(value) {
  const profiles = value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0);
  if (profiles.length === 0) throw new Error("--profiles requires positive integer node counts");
  return [...new Set(profiles)].sort((left, right) => left - right);
}

function parseArgs(argv) {
  let profiles = [...DEFAULT_PROFILES];
  let maxMs = 300000;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profiles") profiles = parseProfiles(argv[++index] ?? "");
    else if (argument === "--include-100k") profiles = [...new Set([...profiles, 100000])].sort((left, right) => left - right);
    else if (argument === "--max-ms") maxMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isFinite(maxMs) || maxMs <= 0) throw new Error("--max-ms must be positive");
  return { profiles, maxMs };
}

function round(value) {
  return Number(value.toFixed(6));
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]);
}

function latencySummary(values) {
  return { count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
}

function heapSample() {
  const usage = process.memoryUsage();
  return { heapUsedBytes: usage.heapUsed, rssBytes: usage.rss, externalBytes: usage.external };
}

function collectGarbage() {
  if (typeof globalThis.gc === "function") globalThis.gc();
}

async function forBatches(count, worker, deadline, label) {
  for (let start = 0; start < count; start += BATCH_SIZE) {
    const end = Math.min(count, start + BATCH_SIZE);
    await Promise.all(Array.from({ length: end - start }, (_, offset) => worker(start + offset)));
    checkDeadline(deadline, label);
  }
}

function docIdFor(index) {
  return `doc${String(index).padStart(6, "0")}`;
}

function memoryIdFor(pattern, index) {
  return `memory:${pattern}:${docIdFor(index)}`;
}

function termsFor(index) {
  return [
    `docid${docIdFor(index)}`,
    `topic${index % 32}`,
    `group${(index * 17 + 3) % 64}`,
    `owner${(index * 13 + 7) % 16}`
  ];
}

function documentText(index, revision = 0) {
  return `${termsFor(index).join(" ")} document external payload ${BODY_MARKER} revision${revision} source${index}\n`;
}

function controlText() {
  return `control external payload ${BODY_MARKER} isolated revision0\n`;
}

function tokenize(text) {
  return new Set(text.toLowerCase().match(/[a-z0-9-]+/g) ?? []);
}

function fileFor(root, index) {
  const shard = String(Math.floor(index / 1000)).padStart(3, "0");
  const filePath = path.join(root, "docs", shard, `${docIdFor(index)}.txt`);
  return { index, docId: docIdFor(index), path: filePath, uri: pathToFileURL(filePath).href };
}

async function createCorpus(tempRoot, nodes, validator, deadline) {
  const root = path.join(tempRoot, `profile-${nodes}`);
  const docsRoot = path.join(root, "docs");
  await mkdir(docsRoot, { recursive: true });
  const shardCount = Math.ceil(nodes / 1000);
  for (let shard = 0; shard < shardCount; shard += 1) await mkdir(path.join(docsRoot, String(shard).padStart(3, "0")), { recursive: true });

  const files = Array.from({ length: nodes }, (_, index) => fileFor(root, index));
  const started = performance.now();
  let documentPayloadBytes = 0;
  for (let index = 0; index < nodes; index += 1) documentPayloadBytes += Buffer.byteLength(documentText(index));
  await forBatches(nodes, (index) => writeFile(files[index].path, documentText(index), "utf8"), deadline, `corpus ${nodes}`);

  const controlPath = path.join(root, "control.txt");
  const control = { docId: "control", path: controlPath, uri: pathToFileURL(controlPath).href };
  await writeFile(controlPath, controlText(), "utf8");
  const payloadBytes = documentPayloadBytes + Buffer.byteLength(controlText());

  await forBatches(nodes, async (index) => { files[index].initialVersion = await validator.versionFor(files[index].uri); }, deadline, `versions ${nodes}`);
  control.initialVersion = await validator.versionFor(control.uri);
  return {
    root,
    files,
    control,
    documentPayloadBytes,
    payloadBytes,
    generationMs: round(performance.now() - started)
  };
}

class InvertedIndex {
  constructor() {
    this.postings = new Map();
    this.docTokens = new Map();
  }

  async load(files, deadline) {
    const started = performance.now();
    await forBatches(files.length, async (index) => {
      const text = await readFile(files[index].path, "utf8");
      this.upsert(files[index].docId, text);
    }, deadline, "index build");
    return round(performance.now() - started);
  }

  async update(file) {
    this.upsert(file.docId, await readFile(file.path, "utf8"));
  }

  upsert(docId, text) {
    const previous = this.docTokens.get(docId);
    if (previous) {
      for (const token of previous) {
        const posting = this.postings.get(token);
        posting?.delete(docId);
        if (posting?.size === 0) this.postings.delete(token);
      }
    }
    const tokens = tokenize(text);
    this.docTokens.set(docId, tokens);
    for (const token of tokens) {
      const posting = this.postings.get(token) ?? new Set();
      posting.add(docId);
      this.postings.set(token, posting);
    }
  }

  query(terms, topK) {
    const uniqueTerms = [...new Set(terms)];
    const scores = new Map();
    for (const term of uniqueTerms) {
      for (const docId of this.postings.get(term) ?? []) scores.set(docId, (scores.get(docId) ?? 0) + 1);
    }
    const ranked = [...scores.entries()].sort(([leftId, leftScore], [rightId, rightScore]) => rightScore - leftScore || leftId.localeCompare(rightId));
    const expected = new Set(ranked.filter(([, score]) => score === uniqueTerms.length).map(([docId]) => docId));
    return { ids: ranked.slice(0, topK).map(([docId]) => docId), expected };
  }

  serializedMetadataBytes() {
    const snapshot = [...this.postings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([term, ids]) => [term, [...ids].sort()]);
    return Buffer.byteLength(JSON.stringify(snapshot));
  }
}

function digestFor(memoryId, dependsOn, provenance) {
  const versions = (provenance ?? []).map((source) => source.version?.token ?? "").join(",");
  return `sha256:${createHash("sha256").update(`${memoryId}|${dependsOn.join(",")}|${versions}`).digest("hex")}`;
}

function makeEnvelope(memoryId, file, version, dependsOn = [], checkedAt = BASE_TIME) {
  const provenance = [{
    sourceUri: file.uri,
    observedAt: checkedAt,
    version,
    validator: { id: "filesystem", operation: "sha256" }
  }];
  return {
    specVersion: SPEC_VERSION,
    memoryId,
    contentDigest: dependsOn.length === 0 ? `sha256:${version.token}` : digestFor(memoryId, dependsOn, provenance),
    provenance,
    validity: { status: "FRESH", checkedAt, policy: "VERSIONED" },
    dependsOn
  };
}

function repairEnvelope(state, currentVersions) {
  const provenance = state.envelope.provenance?.map((source) => ({
    ...source,
    observedAt: REPAIR_TIME,
    ...(currentVersions.has(source.sourceUri) ? { version: currentVersions.get(source.sourceUri) } : {})
  }));
  const dependsOn = [...state.envelope.dependsOn];
  return {
    ...state.envelope,
    ...(provenance ? { provenance, contentDigest: digestFor(state.memoryId, dependsOn, provenance) } : {}),
    validity: { ...state.envelope.validity, status: "FRESH", checkedAt: REPAIR_TIME },
    dependsOn
  };
}

function dependenciesFor(pattern, index) {
  if (pattern === "chain") return index === 0 ? [] : [memoryIdFor(pattern, index - 1)];
  if (pattern === "fanout") return index === 0 ? [] : [memoryIdFor(pattern, 0)];
  if (index < 2) return [];
  return index % 2 === 0 ? [memoryIdFor(pattern, 0), memoryIdFor(pattern, 1)] : [memoryIdFor(pattern, 0)];
}

function changedIndicesFor(pattern, nodes) {
  const primary = pattern === "shared" ? 1 : 0;
  return [...new Set([primary, Math.floor(nodes / 2), nodes - 1])].sort((left, right) => left - right);
}

function targetIndexFor(pattern, nodes) {
  if (pattern === "shared") return nodes % 2 === 0 ? nodes - 1 : nodes - 2;
  return nodes - 1;
}

function buildQueries(nodes, changedIndices) {
  const queries = changedIndices.map((index, ordinal) => ({
    id: `changed-${ordinal}`,
    terms: [`docid${docIdFor(index)}`],
    expectedTarget: docIdFor(index)
  }));
  const targetCount = Math.min(256, Math.max(64, Math.ceil(nodes / 250)));
  for (let queryIndex = 0; queries.length < targetCount; queryIndex += 1) {
    const target = (queryIndex * 7919 + 17) % nodes;
    const terms = termsFor(target);
    queries.push({
      id: `query-${String(queryIndex).padStart(3, "0")}`,
      terms: queryIndex % 3 === 0 ? [terms[1]] : queryIndex % 3 === 1 ? [terms[1], terms[2]] : [terms[3], terms[1]]
    });
  }
  return queries;
}

function memoryIdsForDocIds(pattern, docIds) {
  return docIds.map((docId) => `memory:${pattern}:${docId}`);
}

async function runQueries({ index, queries, protocol, pattern, affected, controlMemoryId }) {
  const durations = [];
  let relevantReturned = 0;
  let returned = 0;
  let hits = 0;
  let blockedCandidates = 0;
  let affectedCandidates = 0;
  let unsafeUses = 0;
  let falseRejects = 0;
  let falseRejectDenominator = 0;

  for (const query of queries) {
    const started = performance.now();
    const search = index.query(query.terms, TOP_K);
    const memoryIds = memoryIdsForDocIds(pattern, search.ids);
    const checks = protocol.check(memoryIds).items;
    const usableDocIds = [];
    for (let index = 0; index < search.ids.length; index += 1) {
      const docId = search.ids[index];
      const memoryId = memoryIds[index];
      const item = checks[index];
      const isAffected = affected.has(memoryId);
      if (isAffected) {
        affectedCandidates += 1;
        if (item?.decision === "USABLE") unsafeUses += 1;
      } else {
        falseRejectDenominator += 1;
        if (item?.decision !== "USABLE") falseRejects += 1;
      }
      if (item?.decision === "USABLE") usableDocIds.push(docId);
      else blockedCandidates += 1;
    }
    const relevant = usableDocIds.filter((docId) => search.expected.has(docId));
    relevantReturned += relevant.length;
    returned += usableDocIds.length;
    const hit = query.expectedTarget ? usableDocIds.includes(query.expectedTarget) : relevant.length > 0;
    if (hit) hits += 1;
    durations.push(performance.now() - started);
  }

  const controlCheck = protocol.check([controlMemoryId]).items[0];
  falseRejectDenominator += 1;
  if (controlCheck.decision !== "USABLE") falseRejects += 1;
  const precision = returned === 0 ? 1 : relevantReturned / returned;
  const safety = affectedCandidates === 0 ? 1 : 1 - unsafeUses / affectedCandidates;
  return {
    queries: queries.length,
    topK: TOP_K,
    precision: round(precision),
    retrievalHitRate: round(hits / queries.length),
    safety: round(safety),
    falseRejectRate: round(falseRejects / falseRejectDenominator),
    blockedCandidates,
    affectedCandidates,
    unsafeUses,
    falseRejects,
    falseRejectDenominator,
    queryLatency: latencySummary(durations)
  };
}

function timedCheck(protocol, memoryId, samples) {
  const started = performance.now();
  const item = protocol.check([memoryId]).items[0];
  samples.push(performance.now() - started);
  return item;
}

function metadataBytes(protocol) {
  return protocol.states.states().reduce((sum, state) => sum + Buffer.byteLength(JSON.stringify(state.envelope)), 0);
}

function affectedTopologicalOrder(graph, affected) {
  const pending = new Map();
  const queue = [];
  for (const memoryId of affected) {
    const dependencyCount = graph.dependenciesOf(memoryId).filter((dependencyId) => affected.has(dependencyId)).length;
    pending.set(memoryId, dependencyCount);
    if (dependencyCount === 0) queue.push(memoryId);
  }
  const order = [];
  for (let index = 0; index < queue.length; index += 1) {
    const memoryId = queue[index];
    order.push(memoryId);
    for (const dependentId of graph.dependentsOf(memoryId)) {
      if (!pending.has(dependentId)) continue;
      const next = pending.get(dependentId) - 1;
      pending.set(dependentId, next);
      if (next === 0) queue.push(dependentId);
    }
  }
  if (order.length !== affected.size) throw new Error("affected graph contains a cycle");
  return order;
}

async function runPattern({ nodes, pattern, corpus, index, deadline }) {
  const started = performance.now();
  collectGarbage();
  const beforeHeap = heapSample();
  const protocol = new ReferenceProtocol(() => BASE_TIME);
  const validator = new FilesystemValidator();
  protocol.registerValidator(validator);
  const registerSamples = [];
  const deriveSamples = [];
  const signalSamples = [];
  const checkSamples = [];
  const validateSamples = [];
  const repairSamples = [];
  const indexUpdateSamples = [];
  const memoryByDocId = new Map();

  for (let indexNumber = 0; indexNumber < nodes; indexNumber += 1) {
    const file = corpus.files[indexNumber];
    const memoryId = memoryIdFor(pattern, indexNumber);
    const envelope = makeEnvelope(memoryId, file, file.initialVersion, dependenciesFor(pattern, indexNumber));
    memoryByDocId.set(file.docId, memoryId);
    const operationStarted = performance.now();
    if (envelope.dependsOn.length === 0) protocol.register(envelope);
    else protocol.derive(envelope);
    (envelope.dependsOn.length === 0 ? registerSamples : deriveSamples).push(performance.now() - operationStarted);
    if (indexNumber % 1000 === 0) checkDeadline(deadline, `${pattern} build`);
  }

  const controlMemoryId = `memory:${pattern}:control`;
  const controlEnvelope = makeEnvelope(controlMemoryId, corpus.control, corpus.control.initialVersion);
  const controlStarted = performance.now();
  protocol.register(controlEnvelope);
  registerSamples.push(performance.now() - controlStarted);

  const changedIndices = changedIndicesFor(pattern, nodes);
  const changedMemoryIds = changedIndices.map((indexNumber) => memoryIdFor(pattern, indexNumber));
  const queries = buildQueries(nodes, changedIndices);
  const targetMemoryId = memoryIdFor(pattern, targetIndexFor(pattern, nodes));
  const before = timedCheck(protocol, targetMemoryId, checkSamples);
  const baseline = await runQueries({ index, queries, protocol, pattern, affected: new Set(), controlMemoryId });

  const mutationStarted = performance.now();
  for (const indexNumber of changedIndices) await writeFile(corpus.files[indexNumber].path, documentText(indexNumber, 1), "utf8");
  const currentVersions = new Map();
  for (const indexNumber of changedIndices) {
    const file = corpus.files[indexNumber];
    currentVersions.set(file.uri, await validator.versionFor(file.uri));
  }
  const mutationMs = round(performance.now() - mutationStarted);

  const indexUpdateStarted = performance.now();
  for (const indexNumber of changedIndices) {
    const updateStarted = performance.now();
    await index.update(corpus.files[indexNumber]);
    indexUpdateSamples.push(performance.now() - updateStarted);
  }
  const indexUpdateMs = round(performance.now() - indexUpdateStarted);

  const affected = new Set();
  const signalReports = [];
  for (const indexNumber of changedIndices) {
    const file = corpus.files[indexNumber];
    const signalStarted = performance.now();
    const report = protocol.signal({
      specVersion: SPEC_VERSION,
      eventId: `context-change:${nodes}:${pattern}:${indexNumber}`,
      type: "SourceChanged",
      occurredAt: "2026-08-09T22:00:01Z",
      payload: { sourceUri: file.uri, version: currentVersions.get(file.uri) }
    });
    signalSamples.push(performance.now() - signalStarted);
    for (const memoryId of report.affected) affected.add(memoryId);
    signalReports.push({ documentId: file.docId, affectedNodes: report.affected.length });
  }

  const afterSignal = timedCheck(protocol, targetMemoryId, checkSamples);
  const postSignal = await runQueries({ index, queries, protocol, pattern, affected, controlMemoryId });

  const validationItems = [];
  for (const memoryId of changedMemoryIds) {
    const validateStarted = performance.now();
    const report = await protocol.validate([memoryId]);
    validateSamples.push(performance.now() - validateStarted);
    const item = report.items[0];
    validationItems.push({ memoryId, result: item.result, status: item.status });
  }
  const controlValidationStarted = performance.now();
  const controlValidation = await protocol.validate([controlMemoryId]);
  validateSamples.push(performance.now() - controlValidationStarted);
  const controlValidationItem = controlValidation.items[0];
  const afterValidation = timedCheck(protocol, targetMemoryId, checkSamples);

  const topological = affectedTopologicalOrder(protocol.states.graph, affected);
  const repairedMemoryIds = new Set(changedMemoryIds);
  const representativeConclusion = topological.find((memoryId) => {
    const state = protocol.states.stateOf(memoryId);
    return affected.has(memoryId) && !repairedMemoryIds.has(memoryId) && Boolean(state?.envelope.dependsOn.length);
  });
  if (representativeConclusion) repairedMemoryIds.add(representativeConclusion);
  for (const memoryId of topological) {
    if (!repairedMemoryIds.has(memoryId)) continue;
    const state = protocol.states.stateOf(memoryId);
    assert(state, `missing affected state ${memoryId}`);
    const repairStarted = performance.now();
    protocol.replace(repairEnvelope(state, currentVersions));
    repairSamples.push(performance.now() - repairStarted);
  }

  const afterRepair = timedCheck(protocol, targetMemoryId, checkSamples);
  const final = await runQueries({ index, queries, protocol, pattern, affected: new Set(), controlMemoryId });
  const afterHeap = heapSample();
  const serializedEnvelopes = JSON.stringify(protocol.states.states().map((state) => state.envelope));
  assert(!serializedEnvelopes.includes(BODY_MARKER), "external payload leaked into PREMiSE envelopes");

  const metadataEnvelopeBytes = metadataBytes(protocol);
  const metadataIndexBytes = index.serializedMetadataBytes();
  const restoreStarted = performance.now();
  for (const indexNumber of changedIndices) await writeFile(corpus.files[indexNumber].path, documentText(indexNumber), "utf8");
  for (const indexNumber of changedIndices) await index.update(corpus.files[indexNumber]);
  const restoreMs = round(performance.now() - restoreStarted);
  checkDeadline(deadline, `${pattern} profile`);

  return {
    profile: nodes,
    nodes,
    pattern,
    seed: `context-corpus-${nodes}-${pattern}`,
    graph: {
      rootSourceMemoryCount: pattern === "shared" ? 2 : 1,
      derivedConclusionCount: nodes - (pattern === "shared" ? 2 : 1),
      sourceBackedNodeCount: nodes,
      controlMemoryCount: 1
    },
    corpus: {
      documentPayloadBytes: corpus.documentPayloadBytes,
      externalPayloadBytes: corpus.payloadBytes,
      externalPayloadStoredInProtocol: false,
      changedDocumentIds: changedIndices.map((indexNumber) => corpus.files[indexNumber].docId)
    },
    queries: { count: queries.length, topK: TOP_K, baseline, postSignal, final },
    checks: {
      targetMemoryId,
      before: { status: before.status, decision: before.decision },
      afterSignal: { status: afterSignal.status, decision: afterSignal.decision },
      afterValidation: { status: afterValidation.status, decision: afterValidation.decision },
      afterRepair: { status: afterRepair.status, decision: afterRepair.decision }
    },
    propagation: {
      changedDocumentCount: changedIndices.length,
      changedMemoryIds,
      affectedNodes: affected.size,
      repairedNodes: repairedMemoryIds.size,
      repairedDerivedConclusionCount: [...repairedMemoryIds].filter((memoryId) => protocol.states.stateOf(memoryId)?.envelope.dependsOn.length).length,
      affectedSample: [...affected].sort().slice(0, 3).concat([...affected].sort().slice(-3)),
      signalReports
    },
    validator: {
      id: validator.id,
      operation: "sha256",
      realFilesystemValidator: true,
      changedChecks: validationItems,
      changedResultCount: validationItems.filter((item) => item.result === "CHANGED").length,
      unchangedControl: { result: controlValidationItem.result, status: controlValidationItem.status }
    },
    metrics: {
      precision: final.precision,
      safety: postSignal.safety,
      falseRejectRate: postSignal.falseRejectRate,
      retrievalHitRate: final.retrievalHitRate,
      latency: {
        register: latencySummary(registerSamples),
        derive: latencySummary(deriveSamples),
        signal: latencySummary(signalSamples),
        check: latencySummary(checkSamples),
        validate: latencySummary(validateSamples),
        repair: latencySummary(repairSamples),
        indexUpdate: latencySummary(indexUpdateSamples),
        query: final.queryLatency
      },
      metadata: {
        protocolEnvelopeBytes: metadataEnvelopeBytes,
        indexMetadataBytes: metadataIndexBytes,
        serializedMetadataBytes: metadataEnvelopeBytes + metadataIndexBytes,
        bytesPerNode: round((metadataEnvelopeBytes + metadataIndexBytes) / nodes),
        journalEvents: protocol.journal.size,
        payloadStoredInProtocol: false
      },
      heap: {
        beforeHeapUsedBytes: beforeHeap.heapUsedBytes,
        afterHeapUsedBytes: afterHeap.heapUsedBytes,
        deltaBytes: Math.max(0, afterHeap.heapUsedBytes - beforeHeap.heapUsedBytes),
        signedDeltaBytes: afterHeap.heapUsedBytes - beforeHeap.heapUsedBytes,
        beforeRssBytes: beforeHeap.rssBytes,
        afterRssBytes: afterHeap.rssBytes,
        gcAvailable: typeof globalThis.gc === "function"
      }
    },
    timings: {
      corpusGenerationMs: corpus.generationMs,
      mutationMs,
      indexUpdateMs,
      restoreMs,
      totalMs: round(performance.now() - started)
    }
  };
}

async function isolationCheck(corpus) {
  const protocol = new ReferenceProtocol(() => BASE_TIME);
  const validator = new FilesystemValidator();
  protocol.registerValidator(validator);
  const first = corpus.files[0];
  const second = corpus.files[1];
  const firstChild = corpus.files[2];
  const secondChild = corpus.files[3];
  protocol.register(makeEnvelope("memory:isolation:a", first, first.initialVersion));
  protocol.register(makeEnvelope("memory:isolation:b", second, second.initialVersion));
  protocol.derive(makeEnvelope("memory:isolation:a-child", firstChild, firstChild.initialVersion, ["memory:isolation:a"]));
  protocol.derive(makeEnvelope("memory:isolation:b-child", secondChild, secondChild.initialVersion, ["memory:isolation:b"]));
  const report = protocol.signal({
    specVersion: SPEC_VERSION,
    eventId: "context-isolation-change",
    type: "SourceChanged",
    occurredAt: "2026-08-09T22:00:01Z",
    payload: { sourceUri: first.uri, version: { scheme: "filesystem.sha256", token: "isolation-change" } }
  });
  const unrelated = protocol.check(["memory:isolation:b", "memory:isolation:b-child"]).items;
  return {
    passed: report.affected.includes("memory:isolation:a") && report.affected.includes("memory:isolation:a-child") && !report.affected.includes("memory:isolation:b") && !report.affected.includes("memory:isolation:b-child") && unrelated.every((item) => item.status === "FRESH" && item.decision === "USABLE"),
    affected: report.affected,
    unrelated: unrelated.map((item) => ({ memoryId: item.memoryId, status: item.status, decision: item.decision }))
  };
}

export async function run(options = parseArgs(process.argv.slice(2))) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== 24) throw new Error(`Node 24 is required; found ${process.versions.node}`);
  const deadline = Date.now() + options.maxMs;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "premise-context-corpus-"));
  const results = [];
  const setups = [];
  let isolation;
  let result;
  try {
    for (const nodes of options.profiles) {
      checkDeadline(deadline, `profile ${nodes}`);
      const validator = new FilesystemValidator();
      const corpus = await createCorpus(tempRoot, nodes, validator, deadline);
      const index = new InvertedIndex();
      const indexBuildStarted = performance.now();
      const indexBuildMs = await index.load(corpus.files, deadline);
      setups.push({ nodes, corpusGenerationMs: corpus.generationMs, indexBuildMs, payloadBytes: corpus.payloadBytes, indexMetadataBytes: index.serializedMetadataBytes() });
      for (const pattern of PATTERNS) results.push(await runPattern({ nodes, pattern, corpus, index, deadline }));
      if (!isolation) isolation = await isolationCheck(corpus);
      await rm(corpus.root, { recursive: true, force: true });
    }
    result = {
      format: "premise-context-corpus-benchmark/0.1",
      runner: "node24",
      seed: "premise-context-corpus-2026-08-09",
      deterministic: true,
      offline: true,
      profiles: options.profiles,
      maxMs: options.maxMs,
      setups,
      results,
      invariants: {
        dependencyPatterns: PATTERNS,
        topologyCount: PATTERNS.length,
        isolation,
        requiredProfiles: [1000, 10000, 50000].every((count) => options.profiles.includes(count))
      },
      corpus: {
        temporary: true,
        cleanedUp: false,
        externalPayloadStoredInProtocol: false,
        payloadBoundary: "document bodies live only in temporary files; envelopes contain URI/version metadata"
      },
      limitations: [
        "Latency and heap values are local process measurements and vary by machine and garbage collection.",
        "The default run keeps 100k optional; use --include-100k when the host has enough time and memory.",
        "Retrieval indexes tokens and metadata, never document bodies in PREMiSE envelopes."
      ]
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  assert(result, "benchmark did not produce a result");
  result.corpus.cleanedUp = true;
  await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    format: result.format,
    profiles: result.profiles,
    results: result.results.map((entry) => ({ profile: entry.profile, pattern: entry.pattern, nodes: entry.nodes, precision: entry.metrics.precision, safety: entry.metrics.safety, falseRejectRate: entry.metrics.falseRejectRate, retrievalHitRate: entry.metrics.retrievalHitRate, totalMs: entry.timings.totalMs })),
    isolation: result.invariants.isolation
  }, null, 2));
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await run();
