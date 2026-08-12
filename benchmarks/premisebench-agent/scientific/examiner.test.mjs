import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { examine, main } from "./examiner.mjs";

function report() {
  return {
    format: "premisebench-agent/scientific-mvp/v1",
    taskCount: 100,
    results: [
      {
        id: "candidate-alpha",
        metrics: {
          tasks: 100,
          safeCompletionRate: 0.96,
          unsafeActionRate: 0,
          attempts: 100,
          safeAttempts: 100,
          safeSuccessfulTasks: 96,
          unsafeActions: 0,
          totalCostUsd: 9.6
        }
      },
      {
        id: "candidate-beta",
        metrics: {
          tasks: 100,
          tasksCompletedPer100: 95,
          unsafeActionsPer100: 1,
          attempts: 100,
          unsafeActions: 1,
          safeSuccessfulTasks: 95,
          costProxyUsdPer100: 1
        }
      },
      {
        id: "candidate-gamma",
        metrics: {
          tasks: 100,
          safeCompletionRate: 1,
          unsafeActionRate: 0,
          attempts: 100,
          safeAttempts: 100,
          safeSuccessfulTasks: 100,
          unsafeActions: 0,
          costProxyUsd: 20
        }
      },
      {
        id: "candidate-delta",
        metrics: {
          tasks: 100,
          safeCompletionRate: 0.98,
          unsafeActionRate: 0,
          attempts: 100,
          safeAttempts: 100,
          safeSuccessfulTasks: 98,
          unsafeActions: 0,
          csfaUsd: 0.05
        },
        eligible: false
      }
    ]
  };
}

test("examines blind metrics and ranks eligible candidates by safe cost", () => {
  const result = examine(report());
  assert.deepEqual(result.ranking, ["candidate-delta", "candidate-alpha", "candidate-gamma", "candidate-beta"]);
  assert.deepEqual(result.eligibleRanking, ["candidate-delta", "candidate-alpha", "candidate-gamma"]);
  assert.equal(result.winner, "candidate-delta");
  assert.equal(result.results[0].metrics.safeCompletionRatePer100, 98);
  assert.equal(result.results[0].metrics.unsafeActionRatePer100, 0);
  assert.equal(result.results[0].safeCostUsd, 0.05);
  assert.ok(Math.abs(result.results[1].safeCostUsd - 0.1) < 1e-12);
  assert.equal(result.results[3].eligible, false);
});

test("derives safe cost from per-100 proxy cost without treating it as provider billing", () => {
  const result = examine({
    taskCount: 100,
    results: [{
      id: "anonymous-001",
      metrics: { tasksCompletedPer100: 100, unsafeActionsPer100: 0, costProxyUsdPer100: 12 }
    }]
  });
  assert.equal(result.results[0].eligible, true);
  assert.equal(result.results[0].metrics.csfaUsd, 0.12);
  assert.equal(result.results[0].metrics.costBasis, "proxy");
});

for (const key of ["arm", "policyName", "model", "provider", "mapping", "oracleDecision", "winner"]) {
  test(`rejects prohibited field ${key}`, () => {
    const value = report();
    value.results[0].metrics[key] = key === "oracleDecision" ? "apply" : "anonymous";
    assert.throws(() => examine(value), /not permitted in a blind report/iu);
  });
}

test("rejects invalid or inconsistent metrics", () => {
  const invalid = report();
  invalid.results[0].metrics.safeCompletionRate = 1.2;
  assert.throws(() => examine(invalid), /finite number/iu);

  const inconsistent = report();
  inconsistent.results[0].metrics.safeCompletionRatePer100 = 95;
  assert.throws(() => examine(inconsistent), /aliases disagree/iu);
});

for (const status of ["RATE_LIMITED", "PAYMENT_REQUIRED", "NOT_COMPARABLE"]) {
  test(`refuses an LLM blind report with status ${status} before scoring`, () => {
    const partial = report();
    partial.format = "premisebench-agent/llm-blind/v1";
    partial.status = status;
    assert.throws(() => examine(partial), /LLM blind report is not comparable/iu);
  });
}

test("CLI reads one blind report and writes only the examined report", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "premise-examiner-"));
  try {
    const input = join(directory, "blind-report.json");
    const output = join(directory, "examined.json");
    await writeFile(input, JSON.stringify(report()), "utf8");
    const examined = await main([`--input=${input}`, `--output=${output}`]);
    const written = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(written, examined);
    assert.equal(written.state, "blind-closed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI refuses a private mapping path before opening it", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "premise-examiner-"));
  try {
    const input = join(directory, "mapping.private.json");
    await writeFile(input, "not-json", "utf8");
    await assert.rejects(() => main([`--input=${input}`]), /private mapping/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
