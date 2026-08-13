import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  assertNoForbiddenFields,
  validateCandidateOutputRecord,
  validatePublicPayload
} from "./protocol.mjs";
import { canonicalJson, sha256Digest } from "./hash.mjs";

export const SEALED_CAMPAIGN_FORMAT = "premise-efficiency-lab/sealed-campaign/v1";
export const SEALED_LABEL = "sealed/local";
export const SEALED_WORKER_FLAG = "--premise-efficiency-lab-sealed-worker";
export const DEFAULT_SEALED_TIMEOUT_MS = 30_000;
export const DEFAULT_SEALED_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const SEALED_PROTOCOL = `${SEALED_CAMPAIGN_FORMAT}/ipc`;
const DEFAULT_NOW = "2026-08-13T00:00:00.000Z";
const DEFAULT_TENANT = "tenant:efficiency-lab-sealed";

function cloneJson(value, label = "value") {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function normalizeVersion(value, label = "version") {
  if (typeof value === "string") return { scheme: "sealed", token: value };
  assertObject(value, label);
  return {
    scheme: assertString(value.scheme, `${label}.scheme`),
    token: assertString(value.token, `${label}.token`)
  };
}

function sameVersion(left, right) {
  return left?.scheme === right?.scheme && left?.token === right?.token;
}

function line(value) {
  assertObject(value, "IPC record");
  assertNoForbiddenFields(value, "IPC record");
  return `${canonicalJson(value)}\n`;
}

function parseLine(value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("IPC line must be non-empty");
  if (Buffer.byteLength(value, "utf8") > 1 * 1024 * 1024) throw new Error("IPC line exceeds 1 MiB");
  let record;
  try {
    record = JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid IPC JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertObject(record, "IPC record");
  assertNoForbiddenFields(record, "IPC record");
  if (canonicalJson(record) !== value) throw new Error("IPC record must use canonical JSON");
  return record;
}

function send(stream, value) {
  if (stream.destroyed || stream.writableEnded) throw new Error("IPC stream is closed");
  stream.write(line(value));
}

function safeEnvironment() {
  const allowed = ["PATH", "TEMP", "TMP", "SystemRoot", "ComSpec"];
  const environment = Object.fromEntries(allowed
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  for (const key of Object.keys(environment)) {
    if (/^(ORACLE|TRUTH|GROUND|PRIVATE|MUTATION|ANSWER|GOLD|EXPECTED|GITHUB_TOKEN|DATABASE_URL|OPENROUTER_API_KEY|ZAI_API_KEY|NODE_OPTIONS)/iu.test(key)) {
      delete environment[key];
    }
  }
  return environment;
}

function topologicalNodes(nodes) {
  const pending = nodes.map((node) => cloneJson(node, "public node"));
  const known = new Set();
  const ordered = [];
  while (pending.length > 0) {
    const index = pending.findIndex((node) => (node.dependsOn ?? []).every((id) => known.has(id)));
    if (index < 0) throw new Error("public graph is cyclic or references an unknown dependency");
    const [node] = pending.splice(index, 1);
    known.add(assertString(node.id, "public node.id"));
    ordered.push(node);
  }
  return ordered;
}

function defaultTask(index, scenario) {
  const suffix = String(index + 1).padStart(3, "0");
  const sourceUri = `sealed://source/${suffix}`;
  const rootId = `memory:sealed-root-${suffix}`;
  const actionMemoryId = `memory:sealed-action-${suffix}`;
  const initialVersion = { scheme: "sealed", token: "v0" };
  const mutation = scenario.mutates
    ? { version: { scheme: "sealed", token: "v1" }, value: { revision: 1 } }
    : undefined;
  const eventDelivered = scenario.eventDelivered === true;
  const publicEvidence = {
    evidenceId: `evidence:${suffix}`,
    sourceUri,
    observedAt: DEFAULT_NOW,
    version: initialVersion,
    validator: { id: "sealed-parent-source", operation: "read" }
  };
  return {
    publicTask: {
      taskId: `sealed-task-${suffix}`,
      tenantId: DEFAULT_TENANT,
      nodes: [
        { id: rootId, evidence: [publicEvidence], content: { kind: "public-root" } },
        { id: actionMemoryId, dependsOn: [rootId], evidence: [publicEvidence], content: { kind: "public-action" } }
      ],
      actionMemoryId,
      action: { kind: "conditional-write", risk: "HIGH" },
      eventDelivered
    },
    privateSpec: {
      sourceUri,
      initialVersion,
      ...(mutation === undefined ? {} : { mutation }),
      deliverEvent: eventDelivered,
      mutationTiming: scenario.mutationTiming ?? "ready",
      affectsAction: scenario.mutates === true
    }
  };
}

function normalizeTask(input, index) {
  const task = assertObject(input, `tasks[${index}]`);
  const publicTask = task.publicTask ?? task.public;
  const privateSpec = task.privateSpec ?? task.private;
  validatePublicPayload(publicTask, `tasks[${index}].publicTask`);
  const publicCopy = cloneJson(publicTask, `tasks[${index}].publicTask`);
  const privateCopy = cloneJson(privateSpec, `tasks[${index}].privateSpec`);
  assertString(publicCopy.taskId, `tasks[${index}].publicTask.taskId`);
  assertString(publicCopy.tenantId, `tasks[${index}].publicTask.tenantId`);
  assertString(publicCopy.actionMemoryId, `tasks[${index}].publicTask.actionMemoryId`);
  if (!Array.isArray(publicCopy.nodes) || publicCopy.nodes.length === 0) throw new TypeError(`tasks[${index}].publicTask.nodes must not be empty`);
  const nodes = topologicalNodes(publicCopy.nodes);
  const knownIds = new Set(nodes.map((node) => node.id));
  if (!knownIds.has(publicCopy.actionMemoryId)) throw new RangeError("actionMemoryId is not in the public graph");

  assertObject(privateCopy, `tasks[${index}].privateSpec`);
  const sourceUri = assertString(privateCopy.sourceUri, `tasks[${index}].privateSpec.sourceUri`);
  const initialVersion = normalizeVersion(privateCopy.initialVersion, `tasks[${index}].privateSpec.initialVersion`);
  const deliverEvent = privateCopy.deliverEvent === true;
  const mutationTiming = privateCopy.mutationTiming ?? "ready";
  if (!["ready", "cas"].includes(mutationTiming)) throw new TypeError("privateSpec.mutationTiming must be ready or cas");
  if (mutationTiming === "cas" && deliverEvent) throw new Error("a CAS-time mutation cannot be delivered before the CAS");
  if (privateCopy.mutation !== undefined) {
    assertObject(privateCopy.mutation, "privateSpec.mutation");
    normalizeVersion(privateCopy.mutation.version, "privateSpec.mutation.version");
  }
  const evidence = nodes.flatMap((node) => node.evidence ?? []).filter((item) => item.sourceUri === sourceUri);
  if (evidence.length === 0) throw new Error("private sourceUri must appear in public evidence");
  if (evidence.some((item) => !sameVersion(normalizeVersion(item.version, "public evidence.version"), initialVersion))) {
    throw new Error("public initial evidence does not match private source state");
  }
  return Object.freeze({
    publicTask: Object.freeze({ ...publicCopy, nodes: Object.freeze(nodes) }),
    privateSpec: Object.freeze({ ...privateCopy, sourceUri, initialVersion, deliverEvent, mutationTiming })
  });
}

function defaultTasks() {
  return [
    defaultTask(0, { mutates: false, eventDelivered: false }),
    defaultTask(1, { mutates: true, eventDelivered: true }),
    defaultTask(2, { mutates: true, eventDelivered: false, mutationTiming: "cas" })
  ].map((task, index) => normalizeTask(task, index));
}

function candidateInput(publicTask) {
  const input = { protocol: SEALED_PROTOCOL, type: "task", public: cloneJson(publicTask, "public task") };
  assertNoForbiddenFields(input, "candidate input");
  return input;
}

function validateWorkerMessage(message) {
  assertObject(message, "candidate message");
  assertNoForbiddenFields(message, "candidate message");
  if (message.protocol !== SEALED_PROTOCOL) throw new Error(`candidate protocol mismatch: ${String(message.protocol)} !== ${SEALED_PROTOCOL}; keys=${Object.keys(message).join(",")}`);
  if (typeof message.type !== "string") throw new Error("candidate message type is required");
  return message;
}

function numericCounters(value) {
  if (value === undefined) return {};
  assertObject(value, "candidate counters");
  return Object.fromEntries(Object.entries(value).filter(([, count]) => Number.isSafeInteger(count) && count >= 0));
}

function sumCounters(left, right) {
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) result[key] = (result[key] ?? 0) + value;
  return result;
}

function childError(error, code = "SEALED_CANDIDATE_FAILED") {
  const result = new Error(error instanceof Error ? error.message : String(error));
  result.code = code;
  return result;
}

function runChildCandidate(publicTask, privateSpec, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEALED_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_SEALED_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new RangeError("maxOutputBytes must be a positive integer");
  const input = candidateInput(publicTask);
  const source = {
    sourceUri: privateSpec.sourceUri,
    version: cloneJson(privateSpec.initialVersion, "initial source version"),
    committed: false
  };
  let child;

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let ready = false;
    let done = false;
    let plan;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let buffer = "";
    let mutationApplied = false;
    const timer = setTimeout(() => finishError(childError(`candidate timed out after ${timeoutMs}ms`, "TIMEOUT")), timeoutMs);

    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* best effort */ }
      rejectPromise(error);
    };
    const finishSuccess = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const write = (record) => {
      try {
        send(child.stdin, { protocol: SEALED_PROTOCOL, ...record });
      } catch (error) {
        finishError(childError(error, "IPC_WRITE_FAILED"));
      }
    };
    const mutate = () => {
      if (mutationApplied || privateSpec.mutation === undefined) return;
      source.version = normalizeVersion(privateSpec.mutation.version, "private mutation.version");
      mutationApplied = true;
    };
    const onReady = () => {
      if (ready) return finishError(childError("candidate sent duplicate ready", "IPC_PROTOCOL_INVALID"));
      ready = true;
      if (privateSpec.mutationTiming === "ready") mutate();
      write({
        type: "event",
        delivered: privateSpec.deliverEvent,
        ...(privateSpec.deliverEvent
          ? {
              sourceUri: source.sourceUri,
              version: source.version,
              eventId: `sealed-event:${publicTask.taskId}`
            }
          : {})
      });
    };
    const onRead = (message) => {
      if (!ready || message.sourceUri !== source.sourceUri) return finishError(childError("candidate requested an unauthorized source", "SOURCE_SCOPE_VIOLATION"));
      write({
        type: "read-result",
        requestId: assertString(message.requestId, "requestId"),
        sourceUri: source.sourceUri,
        exists: true,
        version: source.version
      });
    };
    const onCas = (message) => {
      if (!ready || message.sourceUri !== source.sourceUri) return finishError(childError("candidate requested an unauthorized CAS source", "SOURCE_SCOPE_VIOLATION"));
      if (privateSpec.mutationTiming === "cas") mutate();
      const expectedVersion = normalizeVersion(message.expectedVersion, "expectedVersion");
      const accepted = sameVersion(expectedVersion, source.version);
      if (accepted) source.committed = true;
      write({
        type: "cas-result",
        requestId: assertString(message.requestId, "requestId"),
        accepted,
        ...(accepted ? {} : { reason: "VERSION_MISMATCH", observedVersion: source.version.token })
      });
    };
    const onLine = (rawLine) => {
      try {
        const message = validateWorkerMessage(parseLine(rawLine));
        switch (message.type) {
          case "ready": return onReady();
          case "read": return onRead(message);
          case "cas": return onCas(message);
          case "plan":
            validateCandidateOutputRecord({ type: "plan", plan: message.plan });
            plan = cloneJson(message.plan, "candidate plan");
            return;
          case "done":
            done = true;
            return;
          case "error":
            return finishError(childError("candidate reported an error", "CANDIDATE_ERROR"));
          default:
            return finishError(childError(`unsupported candidate message: ${message.type}`, "IPC_PROTOCOL_INVALID"));
        }
      } catch (error) {
        finishError(childError(error, error?.code ?? "IPC_PROTOCOL_INVALID"));
      }
    };

    try {
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), SEALED_WORKER_FLAG], {
        shell: false,
        cwd: options.cwd ?? process.cwd(),
        env: safeEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finishError(childError(error, "SPAWN_ERROR"));
      return;
    }
    child.stdin.on("error", (error) => finishError(childError(error, "IPC_WRITE_FAILED")));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > maxOutputBytes) return finishError(childError("candidate output exceeds configured limit", "OUTPUT_TOO_LARGE"));
      stdout += chunk;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        if (raw.length > 0) onLine(raw);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr, "utf8") < 4_096) stderr += chunk;
    });
    child.once("error", (error) => finishError(childError(error, "SPAWN_ERROR")));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || !ready || !done || plan === undefined) {
        finishError(childError(`candidate exited without a complete plan (code ${code ?? "signal"})`, "INCOMPLETE_CANDIDATE"));
        return;
      }
      finishSuccess({
        plan,
        counters: numericCounters(plan.counters),
        stderr: stderr.slice(0, 4_096),
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        exitCode: code,
        signal,
        sourceCommitted: source.committed
      });
    });
    try {
      child.stdin.write(`${line(input)}`);
    } catch (error) {
      finishError(childError(error, "IPC_WRITE_FAILED"));
    }
  });
}

function assessTask(task, candidate) {
  const accepted = candidate.plan.actionAccepted === true;
  const affected = task.privateSpec.affectsAction === true;
  const unsafe = accepted && affected;
  const falseBlock = !accepted && !affected;
  const toctouEscape = unsafe && task.privateSpec.mutationTiming === "cas";
  return Object.freeze({
    taskId: task.publicTask.taskId,
    status: "COMPLETE",
    decision: candidate.plan.decision,
    actionAccepted: accepted,
    safety: Object.freeze({
      unsafeAction: unsafe,
      falseBlock,
      toctouEscape,
      affectedMutationDetected: affected && !accepted
    }),
    counters: Object.freeze(candidate.counters),
    sourceCommitted: candidate.sourceCommitted
  });
}

function emptySummary() {
  return {
    tasks: 0,
    safeCompletions: 0,
    unsafeActions: 0,
    falseBlocks: 0,
    toctouEscapes: 0,
    counters: {}
  };
}

function addAssessment(summary, assessment) {
  summary.tasks += 1;
  summary.unsafeActions += assessment.safety.unsafeAction ? 1 : 0;
  summary.falseBlocks += assessment.safety.falseBlock ? 1 : 0;
  summary.toctouEscapes += assessment.safety.toctouEscape ? 1 : 0;
  if (!assessment.safety.unsafeAction) summary.safeCompletions += assessment.actionAccepted ? 1 : 0;
  summary.counters = sumCounters(summary.counters, assessment.counters);
  return summary;
}

function inconclusiveReport(reason, tasks = []) {
  return Object.freeze({
    format: SEALED_CAMPAIGN_FORMAT,
    status: "INCONCLUSIVE",
    label: "INCONCLUSIVE",
    taskCount: tasks.length,
    publicTasks: tasks.map(({ publicTask }) => publicTask),
    tasks: [],
    summary: emptySummary(),
    isolation: Object.freeze({
      label: "INCONCLUSIVE",
      complete: false,
      candidateProcess: false,
      publicInputOnly: false,
      truthOwner: "unknown",
      mutationOwner: "unknown",
      forbiddenFieldsChecked: false,
      shell: false,
      osSandbox: false
    }),
    claims: Object.freeze({
      runtimeCandidateIsPhysical: false,
      candidateOraclePhysicalIsolation: false,
      commercialEfficiencyClaim: false,
      holdoutIndependent: false
    }),
    reason: String(reason)
  });
}

/** Run one sealed task. Truth and mutation remain in this parent process. */
export async function runSealedTask(input, options = {}) {
  let task;
  try {
    task = normalizeTask(input, 0);
    const candidate = await runChildCandidate(task.publicTask, task.privateSpec, options);
    return assessTask(task, candidate);
  } catch (error) {
    return Object.freeze({
      taskId: task?.publicTask?.taskId ?? "unknown",
      status: "INCONCLUSIVE",
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Run a physical PREMiSE candidate in a child process with a public-only task.
 * This proves local process sealing, not an OS sandbox or an external holdout.
 */
export async function runSealedCampaign(options = {}) {
  assertObject(options, "options");
  let tasks;
  try {
    const rawTasks = options.tasks === undefined
      ? defaultTasks()
      : Number.isSafeInteger(options.tasks)
        ? Array.from({ length: options.tasks }, (_, index) => defaultTask(index, { mutates: index % 2 === 1, eventDelivered: index % 2 === 1 }))
        : options.tasks;
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) throw new TypeError("tasks must be a non-empty array or positive integer");
    tasks = rawTasks.map(normalizeTask);
  } catch (error) {
    return inconclusiveReport(error instanceof Error ? error.message : String(error));
  }

  const assessments = [];
  const summary = emptySummary();
  for (const task of tasks) {
    const assessment = await runSealedTask(task, options);
    if (assessment.status !== "COMPLETE") {
      return inconclusiveReport(assessment.reason ?? "candidate task was inconclusive", tasks);
    }
    assessments.push(assessment);
    addAssessment(summary, assessment);
  }
  const publicTasks = tasks.map(({ publicTask }) => publicTask);
  const isolation = Object.freeze({
    label: SEALED_LABEL,
    complete: true,
    candidateProcess: true,
    publicInputOnly: true,
    truthOwner: "parent",
    mutationOwner: "parent",
    forbiddenFieldsChecked: true,
    shell: false,
    osSandbox: false,
    externalHoldout: false
  });
  const report = {
    format: SEALED_CAMPAIGN_FORMAT,
    status: "SEALED",
    label: SEALED_LABEL,
    taskCount: tasks.length,
    publicTasks,
    tasks: assessments,
    summary: {
      ...summary,
      safeCompletionRate: summary.tasks === 0 ? null : summary.safeCompletions / summary.tasks,
      referenceEquivalent: summary.unsafeActions === 0 && summary.falseBlocks === 0 ? "PASS" : "FAIL"
    },
    isolation,
    claims: {
      runtimeCandidateIsPhysical: true,
      candidateOraclePhysicalIsolation: true,
      commercialEfficiencyClaim: false,
      holdoutIndependent: false
    },
    manifest: {
      publicTaskHash: sha256Digest(publicTasks),
      runtime: "@premise/runtime-core/dist",
      candidateBoundary: "child-process-public-only",
      examinerBoundary: "parent-private"
    }
  };
  return Object.freeze(report);
}

async function requestParent(pending, type, payload) {
  const requestId = `${type}:${pending.nextId++}`;
  const promise = new Promise((resolvePromise, rejectPromise) => pending.requests.set(requestId, { resolve: resolvePromise, reject: rejectPromise }));
  send(process.stdout, { protocol: SEALED_PROTOCOL, type, requestId, ...payload });
  return promise;
}

async function runCandidateWorker() {
  const { PremiseRuntime, RuntimeInstrumentationRecorder } = await import("../../../../packages/runtime-core/dist/index.js");
  let buffer = "";
  let taskStarted = false;
  let resolveEvent;
  let rejectEvent;
  const event = new Promise((resolvePromise, rejectPromise) => {
    resolveEvent = resolvePromise;
    rejectEvent = rejectPromise;
  });
  const pending = { nextId: 1, requests: new Map() };
  const write = (record) => send(process.stdout, { protocol: SEALED_PROTOCOL, ...record });

  const handleMessage = (record) => {
    if (record.type === "task") {
      if (taskStarted) throw new Error("candidate received duplicate task");
      taskStarted = true;
      validatePublicPayload(record.public, "candidate public task");
      void execute(record.public).catch((error) => {
        try { write({ type: "error", message: "candidate execution failed" }); } catch { /* parent will time out */ }
        rejectEvent(error);
      });
      return;
    }
    if (record.type === "event") {
      resolveEvent(record);
      return;
    }
    if (record.type === "read-result" || record.type === "cas-result") {
      const requestId = assertString(record.requestId, "requestId");
      const request = pending.requests.get(requestId);
      if (request === undefined) throw new Error(`unknown parent request ${requestId}`);
      pending.requests.delete(requestId);
      request.resolve(record);
      return;
    }
    throw new Error(`unsupported parent message ${record.type}`);
  };

  const execute = async (publicTask) => {
    const now = DEFAULT_NOW;
    const recorder = new RuntimeInstrumentationRecorder();
    const runtime = new PremiseRuntime({
      tenantId: publicTask.tenantId,
      now: () => now,
      instrumentation: recorder,
      incrementalFrontier: true
    });
    const nodes = topologicalNodes(publicTask.nodes);
    for (const node of nodes) {
      const envelope = {
        specVersion: "premise/2",
        tenantId: publicTask.tenantId,
        memoryId: node.id,
        evidence: node.evidence ?? [],
        confidence: { score: null, method: "sealed-local", assessedAt: now },
        conflicts: [],
        temporal: { asOf: now },
        validity: { status: node.status ?? "FRESH", checkedAt: now, policy: "VERSIONED" },
        dependsOn: node.dependsOn ?? [],
        signatures: []
      };
      const record = { envelope, content: node.content ?? { memoryId: node.id } };
      if ((node.dependsOn ?? []).length === 0) runtime.register(record, `sealed-register:${node.id}`);
      else runtime.derive(record, `sealed-derive:${node.id}`);
    }
    const actionMemoryId = publicTask.actionMemoryId;
    write({ type: "ready" });
    const mutationEvent = await event;
    if (mutationEvent.delivered === true) {
      runtime.signalSourceChanged(mutationEvent.sourceUri, mutationEvent.version, mutationEvent.eventId);
      await runtime.revalidateMany([actionMemoryId], async (evidence, record) => {
        recorder.onOperation({ field: "sourceReads" });
        recorder.onOperation({ field: evidence.version === undefined ? "authoritativeReads" : "conditionalReads" });
        const observed = await requestParent(pending, "read", { sourceUri: evidence.sourceUri });
        const version = normalizeVersion(observed.version, "parent version");
        const unchanged = observed.exists === true && sameVersion(evidence.version, version);
        return {
          memoryId: record.envelope.memoryId,
          result: unchanged ? "UNCHANGED" : "CHANGED",
          status: unchanged ? "FRESH" : "INVALID",
          checkedAt: now,
          sourceUri: evidence.sourceUri,
          evidenceId: evidence.evidenceId,
          ...(unchanged ? { version } : { reason: "source version changed" })
        };
      }, `sealed-revalidate:${publicTask.taskId}`);
    }
    const record = runtime.get(actionMemoryId);
    const evidence = record?.envelope.evidence?.[0];
    let action = { accepted: false, reason: "REJECT" };
    if (record !== undefined && evidence?.version?.token !== undefined) {
      action = await runtime.revalidateAndAct(actionMemoryId, {
        expectedVersion: evidence.version.token,
        action: publicTask.action,
        commit: async (_current, expectedVersion) => {
          const result = await requestParent(pending, "cas", { sourceUri: evidence.sourceUri, expectedVersion });
          return result.accepted
            ? { accepted: true, result: "committed" }
            : { accepted: false, reason: "VERSION_MISMATCH", observedVersion: result.observedVersion };
        }
      });
    }
    const plan = {
      decision: action.accepted ? "ACTION" : "REJECT",
      actionAccepted: action.accepted,
      actionReason: action.reason ?? null,
      runtime: "runtime-core",
      counters: recorder.snapshot(),
      decisions: recorder.decisions()
    };
    validateCandidateOutputRecord({ type: "plan", plan });
    write({ type: "plan", plan });
    write({ type: "done", status: "COMPLETE" });
    process.stdin.pause();
    process.stdout.end(() => process.exit(0));
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (raw.length === 0) continue;
      try {
        const record = parseLine(raw);
        if (record.protocol !== SEALED_PROTOCOL) throw new Error(`parent protocol mismatch: ${String(record.protocol)} !== ${SEALED_PROTOCOL}`);
        handleMessage(record);
      } catch (error) {
        try { write({ type: "error", message: "invalid parent message" }); } catch { /* parent will fail closed */ }
        rejectEvent(error);
      }
    }
  });
  process.stdin.on("end", () => {
    if (!taskStarted) rejectEvent(new Error("candidate did not receive a task"));
  });
}

const isMainModule = process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMainModule && process.argv.includes(SEALED_WORKER_FLAG)) {
  await runCandidateWorker();
} else if (isMainModule) {
  const result = await runSealedCampaign();
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    label: result.label,
    taskCount: result.taskCount,
    summary: result.summary,
    claims: result.claims,
    reason: result.reason
  }, null, 2)}\n`);
}
