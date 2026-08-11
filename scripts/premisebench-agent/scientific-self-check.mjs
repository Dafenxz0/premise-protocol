import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const roundArgument = process.argv.find((value) => value.startsWith("--round="));
const directory = resolve(root, ".tmp/scientific-mvp", roundArgument?.slice("--round=".length) || "scientific-mvp-dev");
const json = async (name) => JSON.parse(await readFile(resolve(directory, name), "utf8"));
const forbidden = /^(?:mutation|objective|expected|outcome|oracle|groundTruth|labels?)$/iu;

const manifest = await json("manifest.json");
const plan = await json("plan.json");
const dataset = await json("dataset-manifest.json");
const blind = await json("blind-report.json");
const summary = await json("summary.json");
const idealOracle = await json("ideal-oracle.json");
assert.equal(manifest.format, "premisebench-agent/scientific-mvp/v1");
assert.equal(plan.status, "FROZEN_BEFORE_EXECUTION");
assert.equal(typeof plan.holdout, "boolean");
assert.equal(plan.taskCount, manifest.campaign.tasks);
assert.equal(plan.taskSetHash, manifest.taskSetHash);
assert.equal(typeof manifest.planHash, "string");
assert.equal(manifest.oracle.exposedToAgent, false);
assert.equal(manifest.campaign.holdout, plan.holdout);
assert.equal(plan.datasetRole, plan.holdout ? "sealed-holdout" : "development-control");
assert.match(manifest.reproducibility.node, /^v24\./);
assert.equal(manifest.reproducibility.packageManager, "pnpm@10.13.1");
assert.equal(typeof manifest.reproducibility.runnerHash, "string");
assert.equal(blind.results.length, 6);
assert.equal(summary.results.length, 6);
assert.equal(dataset.tasks.length, manifest.campaign.tasks);
assert.equal(typeof manifest.taskSetHash, "string");
assert.equal(idealOracle.evaluatorOnly, true);
assert.equal(idealOracle.candidate, false);
assert.equal(idealOracle.includedInPolicies, false);
assert.equal(blind.results.some((result) => result.id === idealOracle.id), false);

function assertSafe(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafe(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.test(key), false, `oracle-like field leaked at ${path}.${key}`);
    assertSafe(child, `${path}.${key}`);
  }
}

assertSafe(dataset.tasks);
assert.ok(summary.results.every(({ arm }) => typeof arm === "string"));
assert.ok(blind.results.every(({ id, metrics }) => typeof id === "string" && metrics !== undefined));
assert.ok(blind.results.every(({ metrics }) => metrics.evaluatorOnly !== true && metrics.candidate !== false));
console.log(`Scientific MVP self-check: PASS (${manifest.campaign.tasks} tasks, ${blind.results.length} candidate arms)`);
