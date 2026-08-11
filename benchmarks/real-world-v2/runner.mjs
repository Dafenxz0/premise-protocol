import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { runPostgresReadOnly } from "./postgres.mjs";

const outputDirectory = new URL("./", import.meta.url);
const outputPath = new URL("./results.json", import.meta.url);
const tracePath = new URL("./traces.jsonl", import.meta.url);
const taskPath = new URL("./tasks.json", import.meta.url);

const OFFLINE_BASE = Object.freeze({
  "repository.defaultBranch": "main",
  "repository.latestCommit": "a1",
  "docs.readme": "PREMiSE",
  "issues.42": "open",
  "pulls.7": "merged"
});

const OFFLINE_MUTATIONS = new Map([
  [40, ["docs.readme"]],
  [70, ["issues.42", "repository.latestCommit"]]
]);

const TASK_PROMPTS = Object.freeze({
  "repository.defaultBranch": "¿Cuál es la rama principal que debo usar para abrir un cambio?",
  "repository.latestCommit": "¿Cuál es el identificador del commit más reciente?",
  "docs.readme": "¿Qué nombre identifica el proyecto en su documentación principal?",
  "issues.42": "¿Cuál es el estado actual de la incidencia 42?",
  "pulls.7": "¿Cuál es el estado de la pull request 7?",
  repository: "¿Qué metadatos públicos tiene este repositorio?",
  commits: "¿Cuál es el commit más reciente publicado en este repositorio?",
  readme: "¿Qué contenido devuelve la documentación principal del repositorio?",
  contents: "¿Qué contenido devuelve el archivo package.json?",
  releases: "¿Qué versiones publicadas expone el repositorio?"
});

const STRATEGY_INFO = Object.freeze({
  "direct-read": Object.freeze({
    protocol: "none",
    baseline: true,
    role: "control de lectura fresca",
    implementation: "source-read"
  }),
  "ttl-cache-20": Object.freeze({
    protocol: "none",
    baseline: true,
    role: "baseline sin protocolo; cache temporal",
    implementation: "ttl-cache"
  }),
  "premise-event-cache": Object.freeze({
    protocol: "PREMiSE-v2-reference",
    baseline: false,
    role: "control de invalidación por evento",
    implementation: "deterministic-event-invalidation"
  }),
  "premise-conditional-cache": Object.freeze({
    protocol: "PREMiSE-v2-reference",
    baseline: false,
    role: "control de validación condicional",
    implementation: "conditional-validator-control"
  })
});

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function stable(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function stableJson(value) {
  return `${stable(value)}\n`;
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Json(value) {
  return sha256Bytes(Buffer.from(stableJson(value), "utf8"));
}

function comparableGithub(value, key = "") {
  if (key === "temp_clone_token") return "[EPHEMERAL]";
  if (typeof value === "string" && key === "download_url") {
    try {
      const url = new URL(value);
      url.searchParams.delete("token");
      return url.toString();
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => comparableGithub(item));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, comparableGithub(childValue, childKey)]));
  return value;
}

function answersMatch(actual, expected) {
  return stable(comparableGithub(actual)) === stable(comparableGithub(expected));
}

function normalizeTruth(value) {
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "answer")) {
    return { answer: value.answer, version: value.version };
  }
  return { answer: value, version: undefined };
}

function sanitizeTrace(value) {
  if (Array.isArray(value)) return value.map(sanitizeTrace);
  if (value === null || typeof value !== "object") return value;
  const forbidden = new Set(["answer", "expected", "oracle", "snapshot", "gold", "label", "truth"]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !forbidden.has(key.toLowerCase()))
    .map(([key, child]) => [key, sanitizeTrace(child)]));
}

function metadataFor(strategy) {
  return STRATEGY_INFO[strategy] ?? {
    protocol: "unknown",
    baseline: false,
    role: "unclassified strategy",
    implementation: "unknown"
  };
}

async function measure(strategy, tasks, truthForTask, runTask) {
  const latencies = [];
  const traces = [];
  let correct = 0;
  let fresh = 0;
  let freshnessEligible = 0;
  let errors = 0;
  let requests = 0;
  let responseBytes = 0;
  for (const task of tasks) {
    const started = performance.now();
    let answer;
    let observedVersion;
    let error;
    let taskRequests = 0;
    let taskResponseBytes = 0;
    let extraTrace = {};
    try {
      const result = await runTask(task);
      answer = result?.answer;
      observedVersion = result?.version;
      taskRequests = Number.isFinite(result?.requests) ? result.requests : 0;
      taskResponseBytes = Number.isFinite(result?.responseBytes) ? result.responseBytes : 0;
      extraTrace = sanitizeTrace(result?.trace ?? {});
      requests += taskRequests;
      responseBytes += taskResponseBytes;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      errors += 1;
    }
    const latencyMs = performance.now() - started;
    latencies.push(latencyMs);
    const expected = normalizeTruth(await truthForTask(task));
    const precision = error === undefined && answersMatch(answer, expected.answer);
    const canMeasureFreshness = expected.version !== undefined && expected.version !== null;
    const freshness = canMeasureFreshness && precision && stable(observedVersion) === stable(expected.version);
    if (precision) correct += 1;
    if (canMeasureFreshness) {
      freshnessEligible += 1;
      if (freshness) fresh += 1;
    }
    traces.push({
      strategy,
      taskId: task.id,
      source: task.source,
      precision,
      freshness: canMeasureFreshness ? freshness : null,
      requests: taskRequests,
      responseBytes: taskResponseBytes,
      latencyMs: Number(latencyMs.toFixed(3)),
      ...extraTrace,
      ...(error ? { error } : {})
    });
  }
  const info = metadataFor(strategy);
  return {
    strategy,
    ...info,
    tasks: tasks.length,
    correct,
    correctPer100: Number((correct * 100 / tasks.length).toFixed(2)),
    precision: correct,
    precisionPer100: Number((correct * 100 / tasks.length).toFixed(2)),
    errors,
    errorsPer100: Number((errors * 100 / tasks.length).toFixed(2)),
    freshness: fresh,
    freshnessEligible,
    freshnessPer100: freshnessEligible === 0 ? null : Number((fresh * 100 / freshnessEligible).toFixed(2)),
    requests,
    requestsPer100: Number((requests * 100 / tasks.length).toFixed(2)),
    responseBytes,
    responseBytesPer100: Number((responseBytes * 100 / tasks.length).toFixed(2)),
    costProxy: {
      model: "request-count-plus-response-bytes",
      requestUnits: requests,
      requestUnitsPer100Tasks: Number((requests * 100 / tasks.length).toFixed(2)),
      responseBytes,
      responseBytesPer100Tasks: Number((responseBytes * 100 / tasks.length).toFixed(2)),
      currency: null,
      estimatedUsd: null,
      billingEvidence: false
    },
    p50Ms: Number(percentile(latencies, 0.5).toFixed(3)),
    p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
    p99Ms: Number(percentile(latencies, 0.99).toFixed(3)),
    traces
  };
}

function offlineTasks(total = 100) {
  const keys = Object.keys(OFFLINE_BASE);
  return Array.from({ length: total }, (_, index) => {
    const key = keys[index % keys.length];
    return {
      id: `offline-${index + 1}`,
      prompt: TASK_PROMPTS[key],
      source: `github://fixture/acme/${key}`,
      key,
      index
    };
  });
}

function offlineTruthAt(key, taskIndex) {
  let answer = OFFLINE_BASE[key];
  let version = 1;
  for (const [atTask, keys] of OFFLINE_MUTATIONS) {
    if (taskIndex < atTask || !keys.includes(key)) continue;
    answer = `${answer}-v${version + 1}`;
    version += 1;
  }
  return { answer, version };
}

function offlineWorld() {
  const state = new Map(Object.entries(OFFLINE_BASE).map(([key, answer]) => [key, { answer, version: 1 }]));
  const events = [];
  return {
    tasks: offlineTasks(),
    truth(task) {
      const entry = state.get(task.key);
      if (!entry) throw new Error(`unknown fixture key ${task.key}`);
      return { answer: entry.answer, version: entry.version };
    },
    label(task) {
      return offlineTruthAt(task.key, task.index);
    },
    read(task) {
      const entry = state.get(task.key);
      if (!entry) throw new Error(`unknown fixture key ${task.key}`);
      return {
        answer: entry.answer,
        version: entry.version,
        requests: 1,
        responseBytes: Buffer.byteLength(stable(entry.answer), "utf8")
      };
    },
    mutate(taskNumber) {
      for (const key of OFFLINE_MUTATIONS.get(taskNumber) ?? []) {
        const entry = state.get(key);
        entry.answer = `${entry.answer}-v${entry.version + 1}`;
        entry.version += 1;
        events.push({ atTask: taskNumber, source: `github://fixture/acme/${key}`, version: entry.version });
      }
    },
    events
  };
}

function labelCommitment(tasks, labelFor) {
  return sha256Json(tasks.map((task) => ({ taskId: task.id, label: labelFor(task) })));
}

function publicTaskManifest({ mode, seed, tasks, repository = "acme/fixture" }) {
  return {
    format: "premise-v2-benchmark-task-manifest/1",
    version: "v1",
    split: "paired-user-tasks",
    seed,
    mode,
    source: {
      adapter: "github",
      repository,
      readOnly: true
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      prompt: task.prompt ?? TASK_PROMPTS[task.key] ?? task.key,
      source: task.source,
      connector: "github",
      method: "GET"
    })),
    blindness: {
      labelsExported: false,
      expectedAnswersInTaskManifest: false,
      candidateCanReadOracle: false
    }
  };
}

function offlineLabels(tasks, world) {
  return tasks.map((task) => ({ taskId: task.id, label: world.label(task) }));
}

async function runOffline(seed) {
  const directWorld = offlineWorld();
  const tasks = directWorld.tasks;
  const direct = await measure("direct-read", tasks, directWorld.truth, (task) => {
    directWorld.mutate(task.index);
    return directWorld.read(task);
  });
  const ttlWorld = offlineWorld();
  const ttlCache = new Map();
  const ttl = await measure("ttl-cache-20", tasks, ttlWorld.truth, (task) => {
    ttlWorld.mutate(task.index);
    const cached = ttlCache.get(task.key);
    if (cached && task.index - cached.at < 20) return { answer: cached.answer, version: cached.version, requests: 0 };
    const result = ttlWorld.read(task);
    ttlCache.set(task.key, { answer: result.answer, version: result.version, at: task.index });
    return result;
  });
  const premiseWorld = offlineWorld();
  const premiseCache = new Map();
  const premise = await measure("premise-event-cache", tasks, premiseWorld.truth, (task) => {
    premiseWorld.mutate(task.index);
    const currentEvents = premiseWorld.events.filter((event) => event.atTask === task.index);
    for (const event of currentEvents) premiseCache.delete(event.source.split("/").pop());
    const cached = premiseCache.get(task.key);
    if (cached) return { answer: cached.answer, version: cached.version, requests: 0 };
    const result = premiseWorld.read(task);
    premiseCache.set(task.key, { answer: result.answer, version: result.version });
    return result;
  });
  return {
    mode: "offline-temporal-fixture",
    seed,
    tasks,
    labels: offlineLabels(tasks, premiseWorld),
    mutations: premiseWorld.events,
    strategies: [direct, ttl, premise],
    source: {
      class: "local-deterministic-fixture",
      adapter: "github-fixture",
      networkAccess: false,
      readOnly: true,
      changedSourceTimeline: true
    },
    limitations: [
      "This is a deterministic fixture for CI, not a live GitHub claim.",
      "The fixture has exact answers and no model-generation step.",
      "The PREMiSE row is an event-invalidation reference implementation, not proof of production connector performance.",
      "Response bytes are serialized fixture values and are not a cloud billing measurement."
    ]
  };
}

function parseRepo(value) {
  const match = /^([^/]+)\/([^/]+)$/u.exec(value ?? "");
  if (!match) throw new Error("PREMISE_GITHUB_REPO must be owner/repository");
  return { owner: match[1], repository: match[2] };
}

async function githubGet(path, token, headers = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "premise-protocol-v2-benchmark",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    }
  });
  const rawText = await response.text();
  let body;
  try { body = JSON.parse(rawText); } catch { body = rawText; }
  const metadata = {
    etag: response.headers.get("etag"),
    rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
    rateLimitUsed: response.headers.get("x-ratelimit-used"),
    bodySha256: sha256Bytes(Buffer.from(rawText, "utf8")),
    responseBytes: Buffer.byteLength(rawText, "utf8")
  };
  if (response.status === 304) return { status: 304, body: undefined, rawText, ...metadata };
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${typeof body === "string" ? body.slice(0, 180) : JSON.stringify(body).slice(0, 180)}`);
  return { status: response.status, body, rawText, ...metadata };
}

function githubTasks(owner, repository, endpoints, repetitions) {
  const taskCount = Math.max(100, repetitions * endpoints.length);
  return Array.from({ length: taskCount }, (_, index) => {
    const endpoint = endpoints[index % endpoints.length];
    return {
      id: `live-${index + 1}`,
      prompt: TASK_PROMPTS[endpoint.key],
      source: `github://${owner}/${repository}/${endpoint.key}`,
      key: endpoint.key,
      path: endpoint.path,
      index
    };
  });
}

async function runLive(repetitions, seed) {
  const { owner, repository } = parseRepo(process.env.PREMISE_GITHUB_REPO);
  const token = process.env.GITHUB_TOKEN;
  const endpoints = [
    { key: "repository", path: `/repos/${owner}/${repository}` },
    { key: "commits", path: `/repos/${owner}/${repository}/commits?per_page=1` },
    { key: "readme", path: `/repos/${owner}/${repository}/readme` },
    { key: "contents", path: `/repos/${owner}/${repository}/contents/package.json` },
    { key: "releases", path: `/repos/${owner}/${repository}/releases?per_page=5` }
  ];
  const observed = new Map();
  const truth = new Map();
  const availableEndpoints = [];
  for (const endpoint of endpoints) {
    try {
      const result = await githubGet(endpoint.path, token);
      availableEndpoints.push(endpoint);
      observed.set(endpoint.key, result);
      truth.set(endpoint.key, { answer: result.body, version: result.etag ?? result.bodySha256 });
    } catch (error) {
      if (error instanceof Error && /GitHub 404:/u.test(error.message)) continue;
      throw error;
    }
  }
  if (availableEndpoints.length < 2) throw new Error("Live repository exposed fewer than two benchmark endpoints; check repository visibility and token permissions");
  const tasks = githubTasks(owner, repository, availableEndpoints, repetitions);
  const direct = await measure("direct-read", tasks, (task) => truth.get(task.key), async (task) => {
    const response = await githubGet(task.path, token);
    return {
      answer: response.body,
      version: response.etag ?? response.bodySha256,
      requests: 1,
      responseBytes: response.responseBytes,
      trace: {
        status: response.status,
        etag: response.etag,
        bodySha256: response.bodySha256,
        rateLimitRemaining: response.rateLimitRemaining,
        rateLimitUsed: response.rateLimitUsed,
        cacheHit: false
      }
    };
  });
  const strategies = [direct];
  for (const strategyName of ["ttl-cache-20", "premise-conditional-cache"]) {
    const cache = new Map();
    const strategy = await measure(strategyName, tasks, (task) => truth.get(task.key), async (task) => {
      const cached = cache.get(task.key);
      const shouldRefresh = strategyName === "ttl-cache-20"
        ? cached === undefined || task.index - cached.at >= 20
        : cached === undefined || task.index % 20 === 0;
      if (!shouldRefresh) return { answer: cached.body, version: cached.version, requests: 0, responseBytes: 0, trace: { cacheHit: true } };
      const response = await githubGet(task.path, token, cached?.etag ? { "if-none-match": cached.etag } : {});
      let answer = response.body;
      let version = response.etag ?? response.bodySha256;
      let responseBytes = response.responseBytes;
      if (response.status === 304 && cached !== undefined) {
        answer = cached.body;
        version = cached.version;
        responseBytes = 0;
      }
      cache.set(task.key, { body: answer, version, etag: response.etag ?? cached?.etag, at: task.index });
      return {
        answer,
        version,
        requests: 1,
        responseBytes,
        trace: {
          status: response.status,
          etag: response.etag,
          bodySha256: response.bodySha256,
          rateLimitRemaining: response.rateLimitRemaining,
          rateLimitUsed: response.rateLimitUsed,
          cacheHit: false
        }
      };
    });
    strategies.push(strategy);
  }
  return {
    mode: "live-github-readonly",
    seed,
    tasks,
    labels: tasks.map((task) => ({ taskId: task.id, label: truth.get(task.key) })),
    strategies,
    source: {
      class: "external-live-observation",
      adapter: "github-api",
      apiBase: "https://api.github.com",
      repository: `${owner}/${repository}`,
      networkAccess: true,
      readOnly: true,
      tokenProvided: Boolean(token),
      endpointsObserved: availableEndpoints.map((endpoint) => ({ key: endpoint.key, path: endpoint.path, initialStatus: observed.get(endpoint.key).status, bodySha256: observed.get(endpoint.key).bodySha256 }))
    },
    limitations: [
      "Read-only campaign: no public repository mutation is performed.",
      "The source is observed live, but the repository is not controlled by the benchmark; this run cannot prove mutation recovery.",
      "Answers are exact API payload equality after removing only GitHub ephemeral fields.",
      "A release claim requires repeated runs, a changed-source campaign, and an independent reproduction.",
      "GitHub API request counts and response bytes are transparent cost proxies, not billing evidence."
    ]
  };
}

function parseOption(args, prefix, fallback) {
  const value = args.find((item) => item.startsWith(`${prefix}=`));
  return value === undefined ? fallback : value.slice(prefix.length + 1);
}

async function writeArtifacts(campaign, connector) {
  const repository = campaign.source.repository ?? "acme/fixture";
  const manifest = publicTaskManifest({ mode: campaign.mode, seed: campaign.seed, tasks: campaign.tasks, repository });
  const taskText = stableJson(manifest);
  const connectorTraces = connector?.traces ?? [];
  const traceEntries = campaign.strategies.flatMap((strategy) => strategy.traces).concat(connectorTraces);
  const traceText = `${traceEntries.map((trace) => JSON.stringify({ mode: campaign.mode, ...trace })).join("\n")}\n`;
  const labelCommitment = sha256Json(campaign.labels);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(taskPath, taskText, "utf8");
  await writeFile(tracePath, traceText, "utf8");
  const result = {
    format: "premise-v2-real-world-benchmark/2",
    benchmark: "real-world-v2",
    generatedAt: new Date().toISOString(),
    commit: process.env.PREMISE_COMMIT ?? process.env.GITHUB_SHA ?? null,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    mode: campaign.mode,
    seed: campaign.seed,
    tasks: campaign.tasks.length,
    mutations: campaign.mutations ?? [],
    source: campaign.source,
    taskManifest: manifest,
    evidence: {
      execution: {
        class: campaign.mode === "live-github-readonly" ? "external-live-observation" : "local-runner",
        independent: false,
        blind: true,
        labelsExported: false
      },
      taskSet: {
        path: "tasks.json",
        sha256: sha256Bytes(Buffer.from(taskText, "utf8")),
        bytes: Buffer.byteLength(taskText, "utf8"),
        tasks: campaign.tasks.length
      },
      labels: {
        class: "in-process-oracle-commitment",
        exported: false,
        sha256: labelCommitment,
        note: "This digest commits to labels without publishing answers; it is not an independent attestation."
      },
      rawTrace: {
        kind: "raw-jsonl",
        path: "traces.jsonl",
        sha256: sha256Bytes(Buffer.from(traceText, "utf8")),
        bytes: Buffer.byteLength(traceText, "utf8"),
        lines: traceEntries.length
      }
    },
    claims: {
      eligibleForPublicProductClaim: false,
      reason: "A local run or a single read-only observation is not independent validation of production efficacy."
    },
    limitations: campaign.limitations,
    strategies: campaign.strategies,
    connectors: connector ? { postgres: { ...connector, traceCount: connector.traces.length, traces: undefined } } : {}
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const offline = args.has("--offline") || !live;
const repetitions = Math.max(1, Number.parseInt(parseOption(process.argv.slice(2), "--repetitions", "20"), 10) || 20);
const seed = parseOption(process.argv.slice(2), "--seed", process.env.PREMISE_BENCHMARK_SEED ?? "premise-v2-real-world-v1");
const postgresRequested = args.has("--postgres");
const campaign = live && !offline ? await runLive(repetitions, seed) : await runOffline(seed);
const postgres = postgresRequested ? await runPostgresReadOnly({ seed }) : undefined;
const result = await writeArtifacts(campaign, postgres);
console.log(JSON.stringify({
  mode: result.mode,
  tasks: result.tasks,
  evidence: result.evidence,
  strategies: result.strategies.map(({ strategy, baseline, protocol, precisionPer100, freshnessPer100, requestsPer100, p50Ms, p95Ms, costProxy }) => ({ strategy, baseline, protocol, precisionPer100, freshnessPer100, requestsPer100, responseBytesPer100: costProxy.responseBytesPer100Tasks, p50Ms, p95Ms })),
  postgres: postgres ? { readOnly: postgres.readOnly, tasks: postgres.tasks.length } : "skipped"
}, null, 2));
