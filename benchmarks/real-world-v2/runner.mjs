import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const outputDirectory = new URL("./", import.meta.url);
const outputPath = new URL("./results.json", import.meta.url);
const tracePath = new URL("./traces.jsonl", import.meta.url);

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function measure(strategy, tasks, truthForTask, runTask) {
  const latencies = [];
  const traces = [];
  let correct = 0;
  let errors = 0;
  let requests = 0;
  for (const task of tasks) {
    const started = performance.now();
    let answer;
    let error;
    let taskRequests = 0;
    try {
      const result = runTask(task);
      answer = result.answer;
      taskRequests = result.requests ?? 0;
      requests += taskRequests;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      errors += 1;
    }
    const latencyMs = performance.now() - started;
    latencies.push(latencyMs);
    const expected = truthForTask(task);
    if (error === undefined && stable(answer) === stable(expected)) correct += 1;
    traces.push({ strategy, taskId: task.id, source: task.source, correct: error === undefined && stable(answer) === stable(expected), requests: taskRequests, latencyMs: Number(latencyMs.toFixed(3)), ...(error ? { error } : {}) });
  }
  return {
    strategy,
    tasks: tasks.length,
    correct,
    correctPer100: Number((correct * 100 / tasks.length).toFixed(2)),
    errors,
    errorsPer100: Number((errors * 100 / tasks.length).toFixed(2)),
    requests,
    requestsPer100: Number((requests * 100 / tasks.length).toFixed(2)),
    p50Ms: Number(percentile(latencies, 0.5).toFixed(3)),
    p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
    traces
  };
}

function offlineTasks(total = 100) {
  const names = ["repository.defaultBranch", "repository.latestCommit", "docs.readme", "issues.42", "pulls.7"];
  return Array.from({ length: total }, (_, index) => ({ id: `offline-${index + 1}`, source: `github://fixture/acme/${names[index % names.length]}`, key: names[index % names.length], index }));
}

function offlineWorld() {
  const state = new Map([
    ["repository.defaultBranch", { value: "main", version: 1 }],
    ["repository.latestCommit", { value: "a1", version: 1 }],
    ["docs.readme", { value: "PREMiSE", version: 1 }],
    ["issues.42", { value: "open", version: 1 }],
    ["pulls.7", { value: "merged", version: 1 }]
  ]);
  const mutations = new Map([[40, ["docs.readme"]], [70, ["issues.42", "repository.latestCommit"]]]);
  const events = [];
  return {
    tasks: offlineTasks(),
    truth(task) {
      return state.get(task.key)?.value;
    },
    read(task) {
      const entry = state.get(task.key);
      if (!entry) throw new Error(`unknown fixture key ${task.key}`);
      return { answer: entry.value, version: entry.version, requests: 1 };
    },
    mutate(taskNumber) {
      for (const key of mutations.get(taskNumber) ?? []) {
        const entry = state.get(key);
        entry.value = `${entry.value}-v${entry.version + 1}`;
        entry.version += 1;
        events.push({ atTask: taskNumber, source: `github://fixture/acme/${key}`, version: entry.version });
      }
    },
    events
  };
}

function runOffline() {
  const directWorld = offlineWorld();
  const tasks = directWorld.tasks;
  const direct = measure("direct-read", tasks, directWorld.truth, (task) => directWorld.read(task));
  const ttlWorld = offlineWorld();
  const ttlCache = new Map();
  const ttl = measure("ttl-cache-20", tasks, ttlWorld.truth, (task) => {
    ttlWorld.mutate(task.index);
    const cached = ttlCache.get(task.key);
    if (cached && task.index - cached.at < 20) return { answer: cached.answer, requests: 0 };
    const result = ttlWorld.read(task);
    ttlCache.set(task.key, { answer: result.answer, at: task.index });
    return result;
  });
  const premiseWorld = offlineWorld();
  const premiseCache = new Map();
  const premise = measure("premise-event-cache", tasks, premiseWorld.truth, (task) => {
    premiseWorld.mutate(task.index);
    const currentEvents = premiseWorld.events.filter((event) => event.atTask === task.index);
    for (const event of currentEvents) premiseCache.delete(event.source.split("/").pop());
    const cached = premiseCache.get(task.key);
    if (cached) return { answer: cached.answer, requests: 0 };
    const result = premiseWorld.read(task);
    premiseCache.set(task.key, { answer: result.answer, version: result.version });
    return result;
  });
  return {
    mode: "offline-temporal-fixture",
    generatedAt: new Date().toISOString(),
    tasks: tasks.length,
    mutations: premiseWorld.events,
    limitations: ["This is a deterministic fixture for CI, not a live GitHub claim.", "The fixture has exact answers and no model-generation step."],
    strategies: [direct, ttl, premise]
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
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (response.status === 304) return { status: 304, body: undefined, etag: response.headers.get("etag") };
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${typeof body === "string" ? body.slice(0, 180) : JSON.stringify(body).slice(0, 180)}`);
  return { status: response.status, body, etag: response.headers.get("etag") };
}

async function runLive(repetitions) {
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
      truth.set(endpoint.key, result.body);
    } catch (error) {
      if (error instanceof Error && /GitHub 404:/u.test(error.message)) continue;
      throw error;
    }
  }
  if (availableEndpoints.length < 2) throw new Error("Live repository exposed fewer than two benchmark endpoints; check repository visibility and token permissions");
  const taskCount = Math.max(100, repetitions * availableEndpoints.length);
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const endpoint = availableEndpoints[index % availableEndpoints.length];
    return { id: `live-${index + 1}`, source: `github://${owner}/${repository}/${endpoint.key}`, key: endpoint.key, path: endpoint.path, index };
  });
  const direct = measure("direct-read", tasks, (task) => truth.get(task.key), (task) => ({ answer: observed.get(task.key).body, requests: 1 }));
  const traces = [];
  const strategies = [direct];
  for (const strategyName of ["ttl-cache-20", "premise-conditional-cache"]) {
    const cache = new Map();
    const latencies = [];
    let correct = 0;
    let requests = 0;
    let errors = 0;
    for (const task of tasks) {
      const started = performance.now();
      let answer;
      let taskRequests = 0;
      try {
        const cached = cache.get(task.key);
        const shouldRefresh = strategyName === "ttl-cache-20" ? cached === undefined || task.index - cached.at >= 20 : cached === undefined || task.index % 20 === 0;
        if (!shouldRefresh) answer = cached.body;
        else {
          const response = await githubGet(task.path, token, cached?.etag ? { "if-none-match": cached.etag } : {});
          requests += 1;
          taskRequests = 1;
          if (response.status === 304 && cached !== undefined) answer = cached.body;
          else { answer = response.body; cache.set(task.key, { body: response.body, etag: response.etag, at: task.index }); }
        }
        if (stable(answer) === stable(truth.get(task.key))) correct += 1;
      } catch (error) { errors += 1; traces.push({ strategy: strategyName, taskId: task.id, error: error instanceof Error ? error.message : String(error) }); }
      const latencyMs = performance.now() - started;
      latencies.push(latencyMs);
      traces.push({ strategy: strategyName, taskId: task.id, correct: stable(answer) === stable(truth.get(task.key)), requests: taskRequests, latencyMs: Number(latencyMs.toFixed(3)) });
    }
    strategies.push({ strategy: strategyName, tasks: tasks.length, correct, correctPer100: Number((correct * 100 / tasks.length).toFixed(2)), errors, errorsPer100: Number((errors * 100 / tasks.length).toFixed(2)), requests, requestsPer100: Number((requests * 100 / tasks.length).toFixed(2)), p50Ms: Number(percentile(latencies, 0.5).toFixed(3)), p95Ms: Number(percentile(latencies, 0.95).toFixed(3)), traces: traces.filter((trace) => trace.strategy === strategyName) });
  }
  return {
    mode: "live-github-readonly",
    generatedAt: new Date().toISOString(),
    repository: `${owner}/${repository}`,
    tasks: tasks.length,
    repetitions,
    tokenProvided: Boolean(token),
    limitations: ["Read-only campaign: no public repository mutation is performed.", "Answers are exact API payload equality, not model quality.", "Conditional requests are counted as requests even when GitHub returns 304.", "A release claim requires repeated runs and a separate changed-source campaign."],
    strategies
  };
}

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const offline = args.has("--offline") || !live;
const repetitionsFlag = process.argv.find((value) => value.startsWith("--repetitions="));
const repetitions = Math.max(1, Number(repetitionsFlag?.split("=")[1] ?? 20));
const result = live && !offline ? await runLive(repetitions) : runOffline();
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
const traceLines = result.strategies.flatMap((strategy) => strategy.traces.map((trace) => JSON.stringify({ mode: result.mode, ...trace })));
await writeFile(tracePath, `${traceLines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ mode: result.mode, tasks: result.tasks, strategies: result.strategies.map(({ strategy, correctPer100, requestsPer100, p50Ms, p95Ms }) => ({ strategy, correctPer100, requestsPer100, p50Ms, p95Ms })) }, null, 2));
