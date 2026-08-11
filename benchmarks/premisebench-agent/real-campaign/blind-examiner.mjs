import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const forbiddenKeys = new Set([
  "strategy", "strategyName", "strategyId", "variant", "variantName", "variantId",
  "label", "labels", "policy", "policyName", "policyId", "baseline", "baselineName",
  "baselineId", "winner", "ranking", "rank", "approach", "method", "arm", "treatment",
  "condition", "cohort", "provider", "model", "systemPrompt", "temperature"
]);
const forbiddenText = /\b(?:no[\s_-]*memory|normal[\s_-]*memory|ttl[\s_-]*(?:cache|revalidate)|always[\s_-]*revalidate|version[\s_-]*gate|dependency[\s_-]*gate|prompted[\s_-]*re[-\s]?check)\b/i;

function assert(value, message) {
  if (!value) throw new Error(`Blind examiner: ${message}`);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value), "utf8").digest("hex");
}

function inspectBlind(value, location = "$") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => inspectBlind(child, `${location}[${index}]`));
    return;
  }
  if (!record(value)) {
    if (typeof value === "string") assert(!forbiddenText.test(value), `${location} contains a strategy label`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert(!forbiddenKeys.has(key), `${location}.${key} is not permitted in a blind payload`);
    if (typeof child === "string" && !/^(?:id|runId|anonymousId|taskId|commit|commitSha|gitCommit|taskSetHash|hash|sha256)$/i.test(key)) {
      assert(!forbiddenText.test(child), `${location}.${key} contains a strategy label`);
    }
    inspectBlind(child, `${location}.${key}`);
  }
}

function opaqueId(value) {
  assert(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value), "anonymous id is invalid");
  assert(!/strategy|variant|policy|baseline|winner|ranking|control|treatment|arm|memory|revalidat|ttl/i.test(value), "anonymous id reveals a condition");
  return value;
}

function percentile(values, percentage) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentage / 100) - 1))];
}

function eventType(event) {
  return String(event.type ?? event.kind ?? event.operation ?? "other").toLowerCase().replace(/[\s-]+/g, "_");
}

function isRequest(event) {
  return event.request !== false && !new Set(["start", "finish", "done", "note", "observation", "log"]).has(eventType(event));
}

function isRead(event) {
  return new Set(["read", "fetch", "get", "query", "revalidate"]).has(eventType(event));
}

function traceEvaluation(trace) {
  const evaluation = record(trace.evaluation) ? trace.evaluation : trace;
  assert(typeof evaluation.correct === "boolean", `${trace.taskId} is missing evaluation.correct`);
  assert(typeof evaluation.safe === "boolean", `${trace.taskId} is missing evaluation.safe`);
  assert(typeof evaluation.success === "boolean", `${trace.taskId} is missing evaluation.success`);
  return {
    correct: evaluation.correct,
    safe: evaluation.safe,
    success: evaluation.success,
    falseBlock: Boolean(evaluation.falseBlock)
  };
}

function normalizeTrace(trace, commit) {
  assert(record(trace) && typeof trace.taskId === "string", "every trace needs taskId");
  assert(trace.commit === undefined || trace.commit === commit, `${trace.taskId} has a different commit`);
  const events = Array.isArray(trace.events) ? trace.events : [];
  let tokenTotal = 0;
  let tokenKnown = false;
  let errors = 0;
  let reads = 0;
  let requests = 0;
  for (const event of events) {
    assert(record(event), `${trace.taskId} contains an invalid event`);
    if (!isRequest(event)) continue;
    requests += 1;
    if (isRead(event)) reads += 1;
    if (typeof event.tokens === "number") {
      assert(Number.isFinite(event.tokens) && event.tokens >= 0, `${trace.taskId} has invalid token telemetry`);
      tokenTotal += event.tokens;
      tokenKnown = true;
    }
    if (event.error || event.ok === false || /^(?:error|failed|failure)$/i.test(String(event.status ?? ""))) errors += 1;
  }
  const tokenValue = typeof trace.tokens === "number" ? trace.tokens : tokenKnown ? tokenTotal : null;
  const latencyMs = Number(trace.latencyMs);
  assert(Number.isFinite(latencyMs) && latencyMs >= 0, `${trace.taskId} has invalid latency`);
  return {
    taskId: trace.taskId,
    evaluation: traceEvaluation(trace),
    requests,
    reads,
    errors,
    tokens: tokenValue,
    latencyMs
  };
}

function metrics(result) {
  const traces = result.traces;
  const count = traces.length;
  const tokenValues = traces.map((trace) => trace.tokens).filter((value) => value !== null);
  const correct = traces.filter((trace) => trace.evaluation.correct).length;
  const safe = traces.filter((trace) => trace.evaluation.safe).length;
  const success = traces.filter((trace) => trace.evaluation.success).length;
  const unsafe = count - safe;
  const requests = traces.reduce((sum, trace) => sum + trace.requests, 0);
  const reads = traces.reduce((sum, trace) => sum + trace.reads, 0);
  const errors = traces.reduce((sum, trace) => sum + trace.errors, 0);
  const latencies = traces.map((trace) => trace.latencyMs);
  return {
    taskCount: count,
    correctTasks: correct,
    correctnessPer100: 100 * correct / count,
    safeTasks: safe,
    unsafeTasks: unsafe,
    safetyPer100: 100 * safe / count,
    successTasks: success,
    successPer100: 100 * success / count,
    falseBlocks: traces.filter((trace) => trace.evaluation.falseBlock).length,
    requests,
    requestsPerTask: requests / count,
    requestsPer100: 100 * requests / count,
    reads,
    readsPerTask: reads / count,
    errors,
    errorRate: errors / Math.max(1, requests),
    tokens: tokenValues.length === count ? tokenValues.reduce((sum, value) => sum + value, 0) : null,
    tokensPerTask: tokenValues.length === count ? tokenValues.reduce((sum, value) => sum + value, 0) / count : null,
    tokenTelemetry: tokenValues.length === count ? "measured" : "unknown",
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95)
  };
}

function efficiencyScore(value) {
  const parts = [
    1 - Math.min(1, value.requestsPerTask / 12),
    1 - Math.min(1, value.readsPerTask / 8),
    1 - Math.min(1, value.p95Ms / 5000),
    1 - Math.min(1, value.errorRate)
  ];
  return 100 * parts.reduce((sum, part) => sum + part, 0) / parts.length;
}

export function examine(results) {
  assert(Array.isArray(results) && results.length === 3, "exactly three anonymous results are required");
  results.forEach(inspectBlind);
  const ids = results.map((result) => opaqueId(result.id));
  assert(new Set(ids).size === 3, "anonymous IDs must be unique");
  const normalized = results.map((result) => {
    assert(typeof result.commit === "string" && result.commit.length >= 7, "common commit is required");
    assert(Array.isArray(result.traces) && result.traces.length > 0, `${result.id} has no traces`);
    return { id: result.id, commit: result.commit, taskSetHash: result.taskSetHash ?? null, traces: result.traces.map((trace) => normalizeTrace(trace, result.commit)) };
  });
  assert(new Set(normalized.map((result) => result.commit)).size === 1, "commits do not match");
  const taskSets = normalized.map((result) => result.traces.map((trace) => trace.taskId).sort());
  assert(taskSets.every((taskSet) => canonical(taskSet) === canonical(taskSets[0])), "task sets do not match");
  const scored = normalized.map((result) => {
    const measured = metrics(result);
    const correctness = measured.correctnessPer100;
    const security = measured.safetyPer100;
    const efficiency = efficiencyScore(measured);
    const eligible = measured.unsafeTasks === 0 && measured.correctnessPer100 >= 80 && measured.successPer100 >= 80;
    const score = correctness * 0.45 + security * 0.4 + efficiency * 0.15;
    return { id: result.id, metrics: measured, correctness, security, efficiency, score, eligible };
  }).sort((left, right) => Number(right.eligible) - Number(left.eligible) || right.score - left.score || left.id.localeCompare(right.id));
  const winner = scored.find((result) => result.eligible)?.id ?? null;
  return {
    format: "premisebench-agent/real-blind/v1",
    state: "blind-closed",
    labels: "withheld",
    emitsStrategyLabels: false,
    commit: normalized[0].commit,
    taskCount: normalized[0].traces.length,
    taskSetHash: sha256(taskSets[0]),
    inputSha256: sha256(normalized),
    results: scored,
    ranking: scored.map((result) => result.id),
    rawRanking: scored.map((result) => result.id),
    eligibleRanking: scored.filter((result) => result.eligible).map((result) => result.id),
    winner
  };
}

function number(value) {
  return value === null ? "unknown" : Number(value).toFixed(2);
}

export function renderMarkdown(report) {
  const rows = report.results.map((result) => {
    const metrics = result.metrics;
    return `| ${result.id} | ${metrics.correctnessPer100.toFixed(1)}% | ${metrics.safetyPer100.toFixed(1)}% | ${metrics.requestsPerTask.toFixed(2)} | ${metrics.readsPerTask.toFixed(2)} | ${number(metrics.tokensPerTask)} | ${metrics.p50Ms.toFixed(1)} | ${metrics.p95Ms.toFixed(1)} | ${result.eligible ? "sí" : "no"} |`;
  });
  return [
    "# Informe ciego — campaña real",
    "",
    `Estado: **${report.state}** · etiquetas: **${report.labels}** · tareas: **${report.taskCount}**`,
    `Commit común: \`${report.commit}\``,
    "",
    "| ID anónimo | Correctas | Seguras | Peticiones/tarea | Lecturas/tarea | Tokens/tarea | p50 ms | p95 ms | Elegible |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    `Orden bruto ciego: ${report.rawRanking.join(" → ")}`,
    `Orden ciego entre elegibles: ${report.eligibleRanking.length > 0 ? report.eligibleRanking.join(" → ") : "ninguno"}`,
    `Ganador ciego provisional: ${report.winner ?? "ninguno"}`,
    "",
    "Los tokens se muestran como `unknown` si el runner no proporcionó telemetría. La eficiencia no puede ganar frente a una variante insegura o incorrecta.",
    "",
    `Huella de entrada: \`${report.inputSha256}\` · huella de tareas: \`${report.taskSetHash}\``
  ].join("\n");
}

async function main() {
  const inputs = process.argv.slice(2);
  assert(inputs.length === 3, "usage: node blind-examiner.mjs anonymous-1.json anonymous-2.json anonymous-3.json");
  const paths = inputs.map((input) => path.resolve(input));
  paths.forEach((input) => assert(!/(?:premise|basic|enhanced|strategy|variant|baseline|policy|control|arm|memory|revalidat|ttl)/i.test(path.basename(input)), `input path reveals a condition: ${input}`));
  const results = await Promise.all(paths.map(async (input) => JSON.parse(await readFile(input, "utf8"))));
  const report = examine(results);
  const outputDirectory = path.dirname(paths[0]);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "blind-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDirectory, "blind-report.md"), `${renderMarkdown(report)}\n`, "utf8");
  console.log(renderMarkdown(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
