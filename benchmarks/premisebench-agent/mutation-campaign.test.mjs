import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mutationArmOrder, mutationStrategies } from "./mutation-strategies.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const campaign = resolve(root, "benchmarks/premisebench-agent/mutation-campaign.mjs");
const artifacts = resolve(root, "benchmarks/premisebench-agent/artifacts/mutation-campaign");
const forbiddenAgentField = /^(mutation|objective|outcome|expected|oracle|groundTruth|label|labels)$/iu;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runCampaign(tasks, round) {
  const result = spawnSync(process.execPath, [campaign, `--tasks=${tasks}`, `--seed=${tasks === 100 ? 20260811 : 20260812}`, `--round=${round}`], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /UnhandledPromiseRejection|TypeError|Error:/u);

  const directory = resolve(artifacts, round);
  return {
    report: readJson(resolve(directory, "blind-report.json")),
    manifest: readJson(resolve(directory, "manifest.json")),
    dataset: readJson(resolve(directory, "dataset-manifest.json")),
    candidates: [1, 2, 3].map((index) => readJson(resolve(directory, `candidate-${index}.json`)))
  };
}

function expectedFamilies(tasks) {
  return {
    stable: tasks / 2,
    repairable: tasks / 5,
    incompatible: tasks / 5,
    toctou: tasks / 10
  };
}

function assertNoForbiddenAgentKeys(value, path = "agentInput") {
  assert.ok(value && typeof value === "object", `${path} must be an object`);
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbiddenAgentField.test(key), false, `${path} leaks evaluator field ${key}`);
    if (child && typeof child === "object") assertNoForbiddenAgentKeys(child, `${path}.${key}`);
  }
}

function assertPositiveNumber(value, label) {
  assert.equal(typeof value, "number", `${label} must be numeric`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  assert.ok(value > 0, `${label} must not be a false zero`);
}

function assertClose(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${label}: ${actual} !== ${expected}`);
}

function assertTokenBucket(bucket, label, expectedOperations) {
  assert.ok(bucket && typeof bucket === "object", `${label} is missing`);
  for (const field of ["input", "output", "total", "operations", "costUsd"]) {
    assert.equal(typeof bucket[field], "number", `${label}.${field} must be numeric`);
    assert.ok(Number.isFinite(bucket[field]), `${label}.${field} must be finite`);
  }
  assert.ok(bucket.input >= 0 && bucket.output >= 0, `${label} has negative token counts`);
  assert.equal(bucket.total, bucket.input + bucket.output, `${label}.total double-counts or drops tokens`);
  assert.equal(bucket.operations, expectedOperations, `${label}.operations is inconsistent`);
  assertPositiveNumber(bucket.total, `${label}.total`);
  assertPositiveNumber(bucket.costUsd, `${label}.costUsd`);
}

function assertTraceTokenAccounting(trace) {
  const { tokenProxy } = trace;
  assert.ok(tokenProxy && typeof tokenProxy === "object", `${trace.taskId} token telemetry is missing`);
  const visible = tokenProxy.initialAgentInput;
  const internal = tokenProxy.protocolPayload;
  const external = tokenProxy.externalOperations;
  assertTokenBucket(visible, `${trace.taskId} visible agent input`, 1);
  assertTokenBucket(internal, `${trace.taskId} internal protocol payload`, 1 + trace.localChecks);
  assertTokenBucket(external, `${trace.taskId} external payload`, trace.connectorRequests);
  assertClose(tokenProxy.agentInputTokensProxy, visible.total, `${trace.taskId} visible token metric is inconsistent`);
  assertClose(tokenProxy.agentVisibleTokenProxy, visible.total + external.total, `${trace.taskId} agent-visible token proxy is inconsistent`);
  assertClose(tokenProxy.agentVisibleCostProxy, visible.costUsd + external.costUsd, `${trace.taskId} agent-visible cost proxy is inconsistent`);
  assertClose(tokenProxy.runtimePayloadTokens, internal.total, `${trace.taskId} internal payload token metric is inconsistent`);
  assert.equal(tokenProxy.runtimeOperations, internal.operations, `${trace.taskId} internal operation metric is inconsistent`);
  assert.equal(tokenProxy.runtimePayloadBillable, false, `${trace.taskId} runtime payload must not be billable`);
  assert.equal(tokenProxy.total, visible.total + internal.total + external.total, `${trace.taskId} token total is not additive`);
  assert.equal(tokenProxy.input, visible.input + internal.input + external.input, `${trace.taskId} input total is not additive`);
  assert.equal(tokenProxy.output, visible.output + internal.output + external.output, `${trace.taskId} output total is not additive`);
  assertPositiveNumber(tokenProxy.total, `${trace.taskId} visible+internal token total`);
  assertPositiveNumber(tokenProxy.costUsd, `${trace.taskId} visible+internal cost proxy`);
  assertClose(trace.agentVisibleTokenProxy, tokenProxy.agentVisibleTokenProxy, `${trace.taskId} trace visible token alias is inconsistent`);
  assertClose(trace.agentVisibleCostProxy, tokenProxy.agentVisibleCostProxy, `${trace.taskId} trace visible cost alias is inconsistent`);
}

function assertReportTokenAccounting(metrics, tasks, id) {
  for (const field of [
    "initialAgentInputTokens",
    "initialAgentInputTokensPerTask",
    "protocolPayloadTokens",
    "protocolPayloadTokensPerTask",
    "externalPayloadTokens",
    "externalPayloadTokensPerTask",
    "runtimePayloadTokens",
    "runtimePayloadTokensPerTask",
    "runtimeOperations",
    "runtimeOperationsPerTask",
    "tokenProxyTotal",
    "tokenProxyPerTask",
    "agentVisibleTokenProxy",
    "agentVisibleTokenProxyPerTask",
    "agentVisibleCostProxy",
    "agentVisibleCostProxyPer100",
    "initialAgentInputCostProxyUsd",
    "protocolCostProxyUsd",
    "externalCostProxyUsd",
    "costProxyUsd",
    "costProxyUsdPer100"
  ]) assertPositiveNumber(metrics[field], `${id}.${field}`);
  assert.equal(metrics.agentTokens, null, `${id} provider-visible tokens must remain unknown`);
  assert.equal(metrics.agentTokenStatus, "UNKNOWN", `${id} provider-visible token status must remain unknown`);
  assert.equal(metrics.runtimePayloadBillable, false, `${id} runtime payload must not be billable`);
  assertClose(metrics.runtimePayloadTokens, metrics.protocolPayloadTokens, `${id} runtime payload alias is inconsistent`);
  assertClose(metrics.runtimePayloadTokensPerTask, metrics.protocolPayloadTokensPerTask, `${id} runtime payload per-task alias is inconsistent`);
  assertClose(metrics.runtimeOperationsPerTask, metrics.runtimeOperations / tasks, `${id} runtime operations per task is inconsistent`);
  assertClose(metrics.initialAgentInputTokens, metrics.initialAgentInputTokensPerTask * tasks, `${id} visible token total is inconsistent`);
  assertClose(metrics.protocolPayloadTokens, metrics.protocolPayloadTokensPerTask * tasks, `${id} internal token total is inconsistent`);
  assertClose(metrics.externalPayloadTokens, metrics.externalPayloadTokensPerTask * tasks, `${id} external token total is inconsistent`);
  assertClose(metrics.tokenProxyTotal, metrics.initialAgentInputTokens + metrics.protocolPayloadTokens + metrics.externalPayloadTokens, `${id} token buckets are not additive`);
  assertClose(metrics.tokenProxyPerTask, metrics.tokenProxyTotal / tasks, `${id} tokenProxyPerTask is inconsistent`);
  assertClose(metrics.agentVisibleTokenProxy, metrics.initialAgentInputTokens + metrics.externalPayloadTokens, `${id} agent-visible token proxy includes local runtime payload`);
  assertClose(metrics.agentVisibleTokenProxyPerTask, metrics.agentVisibleTokenProxy / tasks, `${id} agent-visible token proxy per task is inconsistent`);
  assertClose(metrics.agentVisibleCostProxy, metrics.initialAgentInputCostProxyUsd + metrics.externalCostProxyUsd, `${id} agent-visible cost proxy includes local runtime cost`);
  assertClose(metrics.agentVisibleCostProxyPer100, metrics.agentVisibleCostProxy * 100 / tasks, `${id} agent-visible cost proxy per 100 is inconsistent`);
  assertClose(metrics.costProxyUsdPer100, metrics.costProxyUsd * 100 / tasks, `${id} cost proxy is inconsistent`);
}

function assertCampaignContract(campaignResult, tasks) {
  const { report, manifest, dataset, candidates } = campaignResult;
  assert.equal(report.format, "premisebench-agent/mutation-blind/v1");
  assert.equal(report.taskCount, tasks);
  assert.deepEqual(report.mutationFamilies, expectedFamilies(tasks));
  assert.equal(Object.values(report.mutationFamilies).reduce((sum, count) => sum + count, 0), tasks);
  assert.equal(report.labels, "withheld");
  assert.equal(report.providerTokens, null, "provider tokens must remain unknown");
  assert.equal(report.providerCostUsd, null, "provider billing must remain unmeasured");
  assert.equal(report.pricing.status, "proxy-not-provider-billing");
  assert.equal(report.tokenAccounting.doubleCounting, false);
  assert.match(report.tokenAccounting.initialAgentInput, /once/i);
  assert.match(report.tokenAccounting.protocolPayload, /compatibility alias/i);
  assert.match(report.tokenAccounting.runtimePayload, /local/i);
  assert.equal(report.tokenAccounting.runtimePayloadBillable, false);
  assert.match(report.tokenAccounting.runtimeOperations, /internal/i);
  assert.match(report.tokenAccounting.externalOperations, /request.*response/i);
  assert.match(report.tokenAccounting.agentVisibleTokenProxy, /initial.*external.*excludes.*local/i);
  assert.match(report.tokenAccounting.agentVisibleCostProxy, /not provider billing/i);
  assert.equal(report.results.length, mutationArmOrder.length);
  assert.equal(report.rawRanking.length, mutationArmOrder.length);
  assert.ok(Array.isArray(report.eligibleRanking));
  assert.deepEqual(report.eligibleRanking, report.results.filter((result) => result.eligible).map((result) => result.id));

  assert.equal(manifest.format, "premisebench-agent/mutation-task-manifest/v1");
  assert.equal(manifest.taskCount, tasks);
  assert.equal(manifest.tasks.length, tasks);
  assert.equal(manifest.mutationSchedule, "withheld");
  assert.equal(manifest.labels, "withheld");
  assert.equal(manifest.providerTokens, "UNKNOWN");
  assert.equal(manifest.providerCostUsd, "UNKNOWN");
  assert.equal(manifest.providerCost, "NOT_MEASURED");
  assert.equal(manifest.tokenTelemetry, "proxy-only");
  assert.equal(manifest.pricing.status, "proxy-not-provider-billing");
  assert.match(manifest.agentVisibleTokenProxy, /initial.*external.*excludes.*local/i);
  assert.match(manifest.agentVisibleCostProxy, /not provider billing/i);
  assert.deepEqual(dataset.agentInputExcludes, ["mutation", "objective", "expected", "outcome", "labels"]);

  const publicManifest = JSON.stringify(manifest);
  assert.doesNotMatch(publicManifest, /"(?:mutation|objective|outcome|expected|oracle|groundTruth)"\s*:/iu);
  for (const task of manifest.tasks) {
    for (const forbidden of ["family", "mutation", "objective", "outcome", "expected", "oracle", "groundTruth"]) {
      assert.equal(Object.hasOwn(task, forbidden), false, `public task leaks ${forbidden}`);
    }
  }

  for (const candidate of candidates) {
    assert.equal(candidate.traces.length, tasks, `${candidate.id} task coverage changed`);
    assert.equal(candidate.taskSetHash, report.taskSetHash, `${candidate.id} task set is not paired`);
    for (const trace of candidate.traces) {
      assert.deepEqual(Object.keys(trace.agentInput).sort(), ["memory", "prompt", "source", "taskId"]);
      assertNoForbiddenAgentKeys(trace.agentInput);
      assert.equal(trace.agentInput.taskId, trace.taskId);
      assert.equal(trace.agentTokens, null);
      assert.equal(trace.providerTokens, null);
      assert.equal(trace.providerCostUsd, null);
      assert.equal(trace.telemetry.tokenTelemetry, "proxy-only");
      assert.equal(trace.telemetry.agentTokens, "UNKNOWN");
      assert.equal(trace.telemetry.providerTokens, "UNKNOWN");
      assert.equal(trace.telemetry.providerCostUsd, "UNKNOWN");
      assert.equal(trace.telemetry.runtimePayloadBilling, "NOT_BILLABLE");
      assert.equal(trace.telemetry.billingEvidence, false);
      assert.equal(trace.tokenProxy.pricing.status, "proxy-not-provider-billing");
      assertTraceTokenAccounting(trace);
    }
  }

  let sawMutation = false;
  for (const result of report.results) {
    const { metrics } = result;
    assert.equal(Object.hasOwn(metrics, "arm"), false, `${result.id} exposes arm identity`);
    assert.equal(Object.hasOwn(metrics, "name"), false, `${result.id} exposes strategy name`);
    assert.equal(metrics.tasks, tasks);
    assert.equal(metrics.providerTokens, null);
    assert.equal(metrics.providerCostUsd, null);
    assert.equal(metrics.tokenTelemetry, "proxy-only");
    assert.equal(metrics.billingEvidence, false);
    assertReportTokenAccounting(metrics, tasks, result.id);
    const eligibleBySafety = metrics.unsafeActionsPer100 === 0
      && metrics.toctouEscapesPer100 === 0
      && metrics.tasksCompletedPer100 >= 95;
    assert.equal(result.eligible, eligibleBySafety, `${result.id} has a false eligibility result`);
    if (metrics.unsafeActionsPer100 > 0) assert.equal(result.eligible, false, `${result.id} hides unsafe actions`);
    if (metrics.toctouEscapesPer100 > 0) assert.equal(result.eligible, false, `${result.id} hides TOCTOU escapes`);
    sawMutation ||= metrics.mutations > 0;
  }
  assert.equal(sawMutation, true, "campaign must contain mutation-bearing traces");
}

test("mutation campaign keeps the 100-task blind contract", () => {
  assertCampaignContract(runCampaign(100, "contract-100"), 100);
});

test("mutation campaign keeps the 200-task blind contract", () => {
  assertCampaignContract(runCampaign(200, "contract-200"), 200);
});

test("mutation campaign exposes three named strategies with a single public order", () => {
  assert.deepEqual(mutationArmOrder, ["basic", "conventional", "premise"]);
  assert.equal(Object.keys(mutationStrategies).length, 3);
});

test("mutation campaign strategy descriptions state their safety trade-off", () => {
  assert.match(mutationStrategies.basic.description, /observaci/i);
  assert.match(mutationStrategies.conventional.description, /TOCTOU/i);
  assert.match(mutationStrategies.premise.description, /CAS/i);
});
