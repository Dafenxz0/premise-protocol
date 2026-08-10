import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORMAT = "premise-ga-cost/1";
export const INPUT_FORMAT = "premise/ga-cost-input/1";
export const PUBLIC_COST_THRESHOLD_USD_PER_1000 = 0.05;
export const MAX_INPUT_BYTES = 1024 * 1024;

const MODES = new Set(["modeled", "provider-billing", "metered-infrastructure"]);
const SOURCE_KINDS = new Set([
  "cost-model",
  "provider-invoice",
  "provider-export",
  "meter-export",
  "telemetry-export",
  "provider-rate-card"
]);
const USAGE_UNITS = Object.freeze({
  duration: "second",
  cpu: "vCPU-hour",
  memory: "GB-hour",
  egress: "GB"
});
const SOURCE_KINDS_BY_MODE = Object.freeze({
  modeled: new Set(["cost-model"]),
  "provider-billing": new Set(["provider-invoice", "provider-export"]),
  "metered-infrastructure": new Set(["meter-export", "telemetry-export"])
});
const SECRET_KEY = /(secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential|client[_-]?secret|jwt|bearer|session)/iu;
const SECRET_VALUE = [
  /-----BEGIN [^-]*PRIVATE KEY-----/iu,
  /\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+)\b/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-[a-z0-9]{20,}\b/iu,
  /\bBearer\s+[a-z0-9._~+/=-]{12,}\b/iu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/iu,
  /(?:^|[?&#])(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|signature|sig|auth|key|token)\s*=/iu,
  /(?:^|[?&#])[^=]*(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|signature|sig|auth|key|token)[^=]*=/iu
];

export class CostInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CostInputError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CostInputError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, field) {
  if (!isObject(value)) fail("invalid-object", `${field} must be an object`);
  return value;
}

function allowKeys(value, field, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unknown-field", `${field}.${key} is not allowed`);
  }
}

function safeString(value, field, { maximum = 2048 } = {}) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    fail("invalid-string", `${field} must be a non-empty string of at most ${maximum} characters`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail("invalid-string", `${field} contains control characters`);
  return value;
}

function enumValue(value, field, allowed) {
  safeString(value, field, { maximum: 128 });
  if (!allowed.has(value)) fail("invalid-enum", `${field} has an unsupported value`);
  return value;
}

function nonNegativeNumber(value, field, { integer = false, positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("invalid-number", `${field} must be a finite JSON number`);
  if (value < 0 || Object.is(value, -0) || (positive && value === 0)) fail(value < 0 || Object.is(value, -0) ? "negative-number" : "zero-number", `${field} must be greater than zero`);
  if (integer && !Number.isSafeInteger(value)) fail("invalid-integer", `${field} must be a safe integer`);
  return value;
}

function sha256(value, field) {
  safeString(value, field, { maximum: 64 });
  if (!/^[a-f0-9]{64}$/iu.test(value) || /^0{64}$/u.test(value)) fail("invalid-hash", `${field} must be a non-zero SHA-256 digest`);
  return value.toLowerCase();
}

function scanSecrets(value, field = "$", seen = new Set()) {
  if (typeof value === "string") {
    if (SECRET_VALUE.some((pattern) => pattern.test(value))) fail("secret-detected", `${field} contains a secret-like value`);
    return;
  }
  if (!isObject(value) && !Array.isArray(value)) return;
  if (seen.has(value)) fail("cyclic-input", `${field} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSecrets(item, `${field}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) fail("secret-detected", `${field}.${key} resembles a secret field`);
      scanSecrets(item, `${field}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function source(value, field, expectedKinds) {
  const item = requireObject(value, field);
  allowKeys(item, field, new Set(["kind", "reference", "sha256"]));
  const kind = enumValue(item.kind, `${field}.kind`, SOURCE_KINDS);
  if (expectedKinds !== undefined && !expectedKinds.has(kind)) fail("source-mismatch", `${field}.kind is not valid for this measurement mode`);
  const reference = safeString(item.reference, `${field}.reference`);
  if (/\bfixture:\/\//iu.test(reference)) fail("untrusted-source", `${field}.reference cannot point to a fixture`);
  return { kind, reference, sha256: sha256(item.sha256, `${field}.sha256`) };
}

function trace(value) {
  const item = requireObject(value, "trace");
  allowKeys(item, "trace", new Set(["id", "sha256"]));
  const id = safeString(item.id, "trace.id", { maximum: 256 });
  if (/^(?:unknown|unavailable|placeholder|n\/a)$/iu.test(id)) fail("invalid-trace", "trace.id must identify a real trace");
  return { id, sha256: sha256(item.sha256, "trace.sha256") };
}

function usageMetric(value, field, unit, { positive = false } = {}) {
  const item = requireObject(value, field);
  allowKeys(item, field, new Set(["value", "unit"]));
  const number = nonNegativeNumber(item.value, `${field}.value`, { positive });
  if (item.unit !== unit) fail("ambiguous-unit", `${field}.unit must be exactly ${unit}`);
  return { value: number, unit };
}

function usage(value) {
  const item = requireObject(value, "usage");
  allowKeys(item, "usage", new Set(["operations", "duration", "cpu", "memory", "egress"]));
  const operations = nonNegativeNumber(item.operations, "usage.operations", { integer: true, positive: true });
  if (operations > Number.MAX_SAFE_INTEGER) fail("invalid-integer", "usage.operations is too large");
  return {
    operations,
    duration: usageMetric(item.duration, "usage.duration", USAGE_UNITS.duration, { positive: true }),
    cpu: usageMetric(item.cpu, "usage.cpu", USAGE_UNITS.cpu),
    memory: usageMetric(item.memory, "usage.memory", USAGE_UNITS.memory),
    egress: usageMetric(item.egress, "usage.egress", USAGE_UNITS.egress)
  };
}

function unitCost(value, field, unit) {
  const item = requireObject(value, field);
  allowKeys(item, field, new Set(["usdPerUnit", "unit"]));
  const amount = nonNegativeNumber(item.usdPerUnit, `${field}.usdPerUnit`);
  if (item.unit !== unit) fail("ambiguous-unit", `${field}.unit must be exactly ${unit}`);
  return { usdPerUnit: amount, unit };
}

function unitCosts(value, mode) {
  const item = requireObject(value, "unitCosts");
  allowKeys(item, "unitCosts", new Set(["source", "cpu", "memory", "egress"]));
  const rateSourceKinds = mode === "metered-infrastructure"
    ? new Set(["provider-rate-card"])
    : new Set(["provider-rate-card", "cost-model"]);
  return {
    source: source(item.source, "unitCosts.source", rateSourceKinds),
    cpu: unitCost(item.cpu, "unitCosts.cpu", USAGE_UNITS.cpu),
    memory: unitCost(item.memory, "unitCosts.memory", USAGE_UNITS.memory),
    egress: unitCost(item.egress, "unitCosts.egress", USAGE_UNITS.egress)
  };
}

function invoice(value, operations) {
  const item = requireObject(value, "invoice");
  allowKeys(item, "invoice", new Set(["totalUsd", "currency", "operationsCovered"]));
  const totalUsd = nonNegativeNumber(item.totalUsd, "invoice.totalUsd");
  if (item.currency !== "USD") fail("ambiguous-currency", "invoice.currency must be exactly USD");
  const operationsCovered = nonNegativeNumber(item.operationsCovered, "invoice.operationsCovered", { integer: true, positive: true });
  if (operationsCovered !== operations) fail("coverage-mismatch", "invoice.operationsCovered must equal usage.operations");
  return { totalUsd, currency: "USD", operationsCovered };
}

function measurement(value, mode) {
  const item = requireObject(value, "measurement");
  allowKeys(item, "measurement", new Set(["kind"]));
  if (item.kind !== mode) fail("measurement-mismatch", "measurement.kind must match mode");
  return { kind: mode };
}

export function validateCostInput(input) {
  scanSecrets(input);
  const item = requireObject(input, "$input");
  allowKeys(item, "$input", new Set(["schemaVersion", "mode", "measurement", "source", "trace", "usage", "unitCosts", "invoice"]));
  if (item.schemaVersion !== INPUT_FORMAT) fail("invalid-schema", `schemaVersion must be ${INPUT_FORMAT}`);
  const mode = enumValue(item.mode, "mode", MODES);
  const normalized = {
    schemaVersion: INPUT_FORMAT,
    mode,
    measurement: measurement(item.measurement, mode),
    source: source(item.source, "source", SOURCE_KINDS_BY_MODE[mode]),
    trace: trace(item.trace),
    usage: usage(item.usage)
  };
  if (mode === "provider-billing") {
    if (item.unitCosts !== undefined) fail("ambiguous-cost-basis", "provider-billing must use invoice, not unitCosts");
    normalized.invoice = invoice(item.invoice, normalized.usage.operations);
  } else {
    if (item.invoice !== undefined) fail("ambiguous-cost-basis", "this mode must use unitCosts, not invoice");
    normalized.unitCosts = unitCosts(item.unitCosts, mode);
  }
  return normalized;
}

function money(value) {
  if (!Number.isFinite(value)) fail("calculation-overflow", "cost calculation exceeded finite numeric range");
  return Number(value.toFixed(8));
}

function modeledBreakdown(input) {
  const cpuUsd = input.usage.cpu.value * input.unitCosts.cpu.usdPerUnit;
  const memoryUsd = input.usage.memory.value * input.unitCosts.memory.usdPerUnit;
  const egressUsd = input.usage.egress.value * input.unitCosts.egress.usdPerUnit;
  const totalUsd = cpuUsd + memoryUsd + egressUsd;
  if (![cpuUsd, memoryUsd, egressUsd, totalUsd].every(Number.isFinite)) fail("calculation-overflow", "cost calculation exceeded finite numeric range");
  return { cpuUsd, memoryUsd, egressUsd, totalUsd };
}

export function evaluateCost(input, { generatedAt = new Date().toISOString() } = {}) {
  const normalized = validateCostInput(input);
  const calculated = normalized.mode === "provider-billing"
    ? { invoicedUsd: normalized.invoice.totalUsd, totalUsd: normalized.invoice.totalUsd }
    : modeledBreakdown(normalized);
  const perThousandRaw = calculated.totalUsd * 1000 / normalized.usage.operations;
  if (!Number.isFinite(perThousandRaw)) fail("calculation-overflow", "cost-per-thousand calculation exceeded finite numeric range");
  const thresholdPassed = perThousandRaw <= PUBLIC_COST_THRESHOLD_USD_PER_1000;
  const realMeasurement = normalized.mode !== "modeled";
  const reasons = [];
  if (!realMeasurement) reasons.push("modeled-measurement-is-not-real-billing-evidence");
  if (!thresholdPassed) reasons.push("cost-per-thousand-exceeds-public-threshold");
  const result = {
    schema: FORMAT,
    format: FORMAT,
    commit: process.env.PREMISE_COMMIT ?? process.env.GITHUB_SHA ?? null,
    generatedAt,
    source: normalized.source,
    trace: normalized.trace,
    eligibleForGa: realMeasurement && thresholdPassed,
    mode: normalized.mode,
    measurement: {
      kind: normalized.measurement.kind,
      real: realMeasurement,
      classification: realMeasurement ? "real-measurement" : "modeled-only"
    },
    workload: {
      operations: normalized.usage.operations,
      duration: normalized.usage.duration,
      cpu: normalized.usage.cpu,
      memory: normalized.usage.memory,
      egress: normalized.usage.egress
    },
    cost: {
      currency: "USD",
      totalUsd: money(calculated.totalUsd),
      perThousandOperationsUsd: money(perThousandRaw),
      thresholdUsdPerThousandOperations: PUBLIC_COST_THRESHOLD_USD_PER_1000,
      thresholdPassed,
      basis: normalized.mode === "provider-billing" ? "provider-invoice" : "usage-times-unit-cost",
      ...(normalized.mode === "provider-billing"
        ? { breakdownUsd: { invoiced: money(calculated.invoicedUsd) } }
        : {
            breakdownUsd: {
              cpu: money(calculated.cpuUsd),
              memory: money(calculated.memoryUsd),
              egress: money(calculated.egressUsd)
            },
            unitCosts: normalized.unitCosts
          })
    },
    evidence: {
      source: normalized.source,
      trace: normalized.trace,
      evidenceComplete: true,
      realMeasurement,
      eligibleCostEvidence: realMeasurement && thresholdPassed
    },
    reasons
  };
  return result;
}

function argumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail("invalid-cli", `${flag} requires a value`);
  return value;
}

export function parseArgs(argv = process.argv.slice(2)) {
  let input;
  let output;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (flag === "--help" || flag === "-h") {
      help = true;
      continue;
    }
    const value = inlineValue ?? argumentValue(argv, index, flag);
    if (inlineValue === undefined) index += 1;
    if (flag === "--input") input = value;
    else if (flag === "--output") output = value;
    else fail("invalid-cli", `unknown argument ${flag}`);
  }
  if (!help && (input === undefined || input.length === 0)) fail("missing-input", "--input is required; no usage data is invented");
  if (output === "-") fail("invalid-cli", "--output cannot be stdout");
  return { help, input, output };
}

function helpText() {
  return `Usage: node benchmarks/ga-cost/runner.mjs --input PATH [--output PATH]

Reads one strict JSON usage record and calculates USD per 1,000 operations.
The input is mandatory. No invoice, rate or usage value is inferred.

  --input PATH   JSON input path; use - for stdin
  --output PATH  optional JSON result path
  --help         show this help`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readInput(inputPath) {
  let data;
  try {
    data = inputPath === "-" ? await readStdin() : await readFile(inputPath);
  } catch {
    fail("input-unreadable", "input JSON could not be read");
  }
  if (data.byteLength === 0) fail("missing-input", "input JSON is empty");
  if (data.byteLength > MAX_INPUT_BYTES) fail("input-too-large", "input JSON exceeds the safety limit");
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    fail("invalid-json", "input is not valid JSON");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const input = await readInput(options.input);
  const result = evaluateCost(input);
  if (options.output !== undefined) {
    await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(result, null, 2));
}

const entryPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof CostInputError ? error.code : "runtime-error";
    console.error(`[ga-cost] ${code}: ${error instanceof Error ? error.message : "runner failed"}`);
    process.exitCode = 1;
  });
}
