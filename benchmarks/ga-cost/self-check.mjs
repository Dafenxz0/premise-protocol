import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CostInputError,
  INPUT_FORMAT,
  PUBLIC_COST_THRESHOLD_USD_PER_1000,
  evaluateCost
} from "./runner.mjs";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH_2 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function baseInput(mode = "metered-infrastructure") {
  const real = mode !== "modeled";
  return {
    schemaVersion: INPUT_FORMAT,
    mode,
    measurement: { kind: mode },
    source: {
      kind: mode === "modeled" ? "cost-model" : mode === "provider-billing" ? "provider-invoice" : "meter-export",
      reference: mode === "modeled" ? "cost-model://self-check" : "billing://redacted-self-check",
      sha256: HASH
    },
    trace: { id: `trace-self-check-${mode}`, sha256: HASH_2 },
    usage: {
      operations: 100_000,
      duration: { value: 3_600, unit: "second" },
      cpu: { value: 100, unit: "vCPU-hour" },
      memory: { value: 500, unit: "GB-hour" },
      egress: { value: 10, unit: "GB" }
    },
    ...(real
      ? mode === "provider-billing"
        ? { invoice: { totalUsd: 4.5, currency: "USD", operationsCovered: 100_000 } }
        : {
            unitCosts: {
              source: { kind: "provider-rate-card", reference: "rate-card://self-check", sha256: HASH_2 },
              cpu: { usdPerUnit: 0.02, unit: "vCPU-hour" },
              memory: { usdPerUnit: 0.001, unit: "GB-hour" },
              egress: { usdPerUnit: 0.1, unit: "GB" }
            }
          }
      : {
          unitCosts: {
            source: { kind: "cost-model", reference: "cost-model://self-check-rate", sha256: HASH_2 },
            cpu: { usdPerUnit: 0.02, unit: "vCPU-hour" },
            memory: { usdPerUnit: 0.001, unit: "GB-hour" },
            egress: { usdPerUnit: 0.1, unit: "GB" }
          }
        })
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof CostInputError && error.code === code, `expected ${code}`);
}

const metered = evaluateCost(baseInput(), { generatedAt: "2026-08-10T00:00:00.000Z" });
assert.equal(metered.format, "premise-ga-cost/1");
assert.equal(metered.mode, "metered-infrastructure");
assert.equal(metered.cost.totalUsd, 3.5);
assert.equal(metered.cost.perThousandOperationsUsd, 0.035);
assert.equal(metered.cost.thresholdPassed, true);
assert.equal(metered.eligibleForGa, true);
assert.equal(metered.evidence.evidenceComplete, true);

const provider = evaluateCost(baseInput("provider-billing"), { generatedAt: "2026-08-10T00:00:00.000Z" });
assert.equal(provider.cost.basis, "provider-invoice");
assert.equal(provider.cost.totalUsd, 4.5);
assert.equal(provider.cost.perThousandOperationsUsd, 0.045);
assert.equal(provider.eligibleForGa, true);

const expensive = baseInput("provider-billing");
expensive.invoice.totalUsd = 5.01;
const expensiveResult = evaluateCost(expensive, { generatedAt: "2026-08-10T00:00:00.000Z" });
assert.equal(expensiveResult.cost.thresholdPassed, false);
assert.equal(expensiveResult.eligibleForGa, false);
assert.ok(expensiveResult.reasons.includes("cost-per-thousand-exceeds-public-threshold"));

const modeled = evaluateCost(baseInput("modeled"), { generatedAt: "2026-08-10T00:00:00.000Z" });
assert.equal(modeled.cost.perThousandOperationsUsd, 0.035);
assert.equal(modeled.measurement.real, false);
assert.equal(modeled.eligibleForGa, false);
assert.ok(modeled.reasons.includes("modeled-measurement-is-not-real-billing-evidence"));

const deterministicA = evaluateCost(baseInput(), { generatedAt: "2026-08-10T00:00:00.000Z" });
const deterministicB = evaluateCost(baseInput(), { generatedAt: "2026-08-10T00:00:00.000Z" });
assert.deepEqual(deterministicA, deterministicB, "calculation must be deterministic for fixed input and timestamp");
assert.equal(PUBLIC_COST_THRESHOLD_USD_PER_1000, 0.05);

const negative = baseInput();
negative.usage.cpu.value = -1;
expectCode(() => evaluateCost(negative), "negative-number");

const negativeRate = baseInput();
negativeRate.unitCosts.cpu.usdPerUnit = -0.01;
expectCode(() => evaluateCost(negativeRate), "negative-number");

const ambiguousUnit = baseInput();
ambiguousUnit.usage.duration.unit = "seconds";
expectCode(() => evaluateCost(ambiguousUnit), "ambiguous-unit");

const missingSourceHash = baseInput();
delete missingSourceHash.source.sha256;
expectCode(() => evaluateCost(missingSourceHash), "invalid-string");

const missingTrace = baseInput();
delete missingTrace.trace;
expectCode(() => evaluateCost(missingTrace), "invalid-object");

const secretField = baseInput();
secretField.apiKey = "not-allowed";
expectCode(() => evaluateCost(secretField), "secret-detected");

const secretReference = baseInput();
secretReference.source.reference = "https://billing.invalid/export?access_token=leaked";
expectCode(() => evaluateCost(secretReference), "secret-detected");

const secretKeyReference = baseInput();
secretKeyReference.source.reference = "https://billing.invalid/export?key=leaked";
expectCode(() => evaluateCost(secretKeyReference), "secret-detected");

const mismatch = baseInput("provider-billing");
mismatch.invoice.operationsCovered = 99_999;
expectCode(() => evaluateCost(mismatch), "coverage-mismatch");

const runnerPath = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const missingInputRun = spawnSync(process.execPath, [runnerPath], { encoding: "utf8" });
assert.notEqual(missingInputRun.status, 0, "CLI must fail when input is absent");
assert.match(`${missingInputRun.stdout}\n${missingInputRun.stderr}`, /missing-input/u);

const unreadableInputRun = spawnSync(process.execPath, [runnerPath, "--input", "__ga_cost_input_does_not_exist__.json"], { encoding: "utf8" });
assert.notEqual(unreadableInputRun.status, 0, "CLI must fail when input cannot be read");
assert.match(`${unreadableInputRun.stdout}\n${unreadableInputRun.stderr}`, /input-unreadable/u);

console.log(JSON.stringify({
  status: "PASS",
  testedModes: ["modeled", "provider-billing", "metered-infrastructure"],
  thresholdUsdPerThousandOperations: PUBLIC_COST_THRESHOLD_USD_PER_1000,
  rejected: ["missing-input", "input-unreadable", "negative-number", "ambiguous-unit", "secret-detected", "coverage-mismatch"],
  note: "self-checks are deterministic regression tests, not GA evidence"
}, null, 2));
