import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GA_THRESHOLDS, parseArgs as parseSoakArgs, runSoak } from "./runner.mjs";
import {
  POSTGRES_TELEMETRY_FORMAT,
  databaseUrl,
  openPostgresTelemetry,
  summarizePostgresTelemetry
} from "./postgres-telemetry.mjs";

export const DIAGNOSTIC_FORMAT = "premise-ga-soak/diagnostic/1";
export const ACCEPTANCE_THRESHOLDS = Object.freeze({
  minimumCheckpointTimeMs: 100,
  checkpointTimeShareOfWindow: 0.25,
  checkpointPacingMaximumTimeShare: 0.75,
  checkpointSyncShareOfCheckpoint: 0.05,
  connectionUtilization: 0.9
});

const DEFAULT_TELEMETRY_INTERVAL_MS = 1_000;
const DEFAULT_TELEMETRY_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT = fileURLToPath(new URL("./diagnostic-results.json", import.meta.url));

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive safe integer`);
  return parsed;
}

function argumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/giu, "$1<redacted>@").slice(0, 240);
}

function errorEntry(error, kind = "telemetry") {
  return { kind, message: safeError(error) };
}

function percentage(value) {
  return value === null || value === undefined ? null : Number((value * 100).toFixed(2));
}

function acceptanceFailure(classification, reason, actions, evidence = {}) {
  return { passed: false, classification, reason, actions, evidence };
}

export function classifyAcceptance(soak, telemetry, thresholds = ACCEPTANCE_THRESHOLDS) {
  if (soak?.setup?.ok !== true) {
    return acceptanceFailure("setup-failed", "The PREMiSE target did not complete diagnostic setup.", [
      "Fix readiness, capabilities, or seed-write errors shown in the soak setup result, then rerun the diagnostic."
    ]);
  }

  if (!telemetry?.available) {
    return acceptanceFailure("telemetry-unavailable", "Two complete PostgreSQL telemetry samples were not captured.", [
      "Set PREMISE_SOAK_DATABASE_URL (or DATABASE_URL/POSTGRES_URL) to the benchmark database and ensure the existing pg driver is installed.",
      "Verify the benchmark role can read pg_stat_checkpointer or pg_stat_bgwriter, pg_stat_wal, pg_stat_database, and pg_stat_activity."
    ]);
  }

  if (telemetry.errors?.length > 0) {
    return acceptanceFailure("telemetry-incomplete", "At least one PostgreSQL telemetry sample failed, so the evidence window is incomplete.", [
      "Resolve the sampled PostgreSQL query error, rerun the full window, and keep the telemetry error list with the evidence artifact."
    ], { errors: telemetry.errors });
  }

  const summary = telemetry.summary ?? telemetry;
  if (summary.statsResetDetected === true) {
    return acceptanceFailure("telemetry-reset", "PostgreSQL statistics reset during the measured window; counter deltas are not trustworthy.", [
      "Repeat the soak without restarting or resetting PostgreSQL statistics during the measured window."
    ]);
  }

  if (summary.configuration?.changed === true) {
    return acceptanceFailure("configuration-changed", "Effective PostgreSQL durability or checkpoint settings changed during the measured window.", [
      "Repeat the soak with PostgreSQL configuration frozen for the complete evidence window.",
      "Preserve configuration.start and configuration.end so the database owner can identify the setting that changed."
    ], { configuration: summary.configuration });
  }

  const telemetryCompleteness = [
    ["soak.metrics.requests", soak.metrics?.requests],
    ["soak.metrics.failed", soak.metrics?.failed],
    ["soak.metrics.latency.p95Ms", soak.metrics?.latency?.p95Ms],
    ["soak.metrics.latency.p99Ms", soak.metrics?.latency?.p99Ms],
    ["postgresTelemetry.summary.elapsedMs", summary.elapsedMs],
    ["postgresTelemetry.summary.checkpoint.totalTimeMs", summary.checkpoint?.totalTimeMs],
    ["postgresTelemetry.summary.checkpoint.timeShareOfWindow", summary.checkpoint?.timeShareOfWindow],
    ["postgresTelemetry.summary.checkpoint.requested", summary.checkpoint?.requested],
    ["postgresTelemetry.summary.checkpoint.timed", summary.checkpoint?.timed],
    ["postgresTelemetry.summary.checkpoint.writeTimeMs", summary.checkpoint?.writeTimeMs],
    ["postgresTelemetry.summary.checkpoint.syncTimeMs", summary.checkpoint?.syncTimeMs],
    ["postgresTelemetry.summary.wal.bytes", summary.wal?.bytes],
    ["postgresTelemetry.summary.connections.peakUtilization", summary.connections?.peakUtilization]
  ].filter(([, value]) => !Number.isFinite(value));
  if (telemetryCompleteness.length > 0) {
    return acceptanceFailure("telemetry-incomplete", "The soak artifact is missing a required HTTP SLO or PostgreSQL telemetry value; incomplete evidence cannot be accepted.", [
      "Capture complete metrics and telemetry for the entire window, including checkpoint, WAL, latency, request, and connection fields.",
      "Do not fill missing values with zero or null; rerun the diagnostic against the real deployment."
    ], { missing: telemetryCompleteness.map(([field]) => field) });
  }

  const connectionUtilization = summary.connections?.peakUtilization;
  if (Number.isFinite(connectionUtilization) && connectionUtilization >= thresholds.connectionUtilization) {
    return acceptanceFailure(
      "connection-saturated",
      `Peak PostgreSQL connection usage reached ${percentage(connectionUtilization)}% of max_connections.`,
      [
        "Compare active, idle, waiting, and idle-in-transaction connection counts with the per-operation latency rows.",
        "Have the database owner investigate pool sizing, connection leaks, and query wait events before changing application concurrency."
      ],
      { peakConnections: summary.connections.peak, maxConnections: summary.connections.peak?.max ?? summary.connections.max }
    );
  }

  if ((soak.metrics?.failed ?? 0) > 0) {
    return acceptanceFailure("http-errors", `${soak.metrics.failed} measured PREMiSE operation(s) failed semantic or transport validation.`, [
      "Use metrics.errors.samples and metrics.byOperation to identify the failing operation, status, and latency tail before accepting the soak."
    ], { errors: soak.metrics.errors });
  }

  const p95Ms = soak.metrics?.latency?.p95Ms;
  if (Number.isFinite(p95Ms) && p95Ms > GA_THRESHOLDS.maximumP95Ms) {
    return acceptanceFailure("latency-gate-failed", `Global p95 latency was ${p95Ms} ms, above the ${GA_THRESHOLDS.maximumP95Ms} ms acceptance limit.`, [
      "Use metrics.byOperation to locate the operation responsible for the p95 tail, then compare it with PostgreSQL WAL and connection deltas."
    ], { observedP95Ms: p95Ms, maximumP95Ms: GA_THRESHOLDS.maximumP95Ms, observedP99Ms: soak.metrics?.latency?.p99Ms ?? null, maximumP99Ms: GA_THRESHOLDS.maximumP99Ms });
  }

  const p99Ms = soak.metrics?.latency?.p99Ms;
  if (Number.isFinite(p99Ms) && p99Ms > GA_THRESHOLDS.maximumP99Ms) {
    return acceptanceFailure("latency-gate-failed", `Global p99 latency was ${p99Ms} ms, above the ${GA_THRESHOLDS.maximumP99Ms} ms acceptance limit.`, [
      "Use metrics.byOperation to locate the operation responsible for the p99 tail, then compare it with PostgreSQL WAL and connection deltas."
    ], { observedP95Ms: p95Ms ?? null, maximumP95Ms: GA_THRESHOLDS.maximumP95Ms, observedP99Ms: p99Ms, maximumP99Ms: GA_THRESHOLDS.maximumP99Ms });
  }

  const checkpoint = summary.checkpoint;
  const checkpointDominates = checkpoint
    && Number.isFinite(checkpoint.totalTimeMs)
    && Number.isFinite(checkpoint.timeShareOfWindow)
    && checkpoint.totalTimeMs >= thresholds.minimumCheckpointTimeMs
    && checkpoint.timeShareOfWindow >= thresholds.checkpointTimeShareOfWindow;
  if (checkpointDominates) {
    const writeTimeMs = checkpoint.writeTimeMs;
    const syncTimeMs = checkpoint.syncTimeMs;
    const buffers = checkpoint.buffers;
    const requests = soak.metrics?.requests;
    const walBytesPerRequest = Number.isFinite(summary.wal?.bytes) && Number.isFinite(requests) && requests > 0
      ? Number((summary.wal.bytes / requests).toFixed(3))
      : null;
    const writeTimePerBufferMs = Number.isFinite(writeTimeMs) && Number.isFinite(buffers) && buffers > 0
      ? Number((writeTimeMs / buffers).toFixed(3))
      : null;
    const dominantPhase = Number.isFinite(writeTimeMs) && Number.isFinite(syncTimeMs) && writeTimeMs >= syncTimeMs
      ? "checkpoint-write"
      : "checkpoint-sync";
    const syncShareOfCheckpoint = Number.isFinite(syncTimeMs) && checkpoint.totalTimeMs > 0
      ? syncTimeMs / checkpoint.totalTimeMs
      : null;
    const checkpointPaced = checkpoint.requested === 0
      && Number.isFinite(syncShareOfCheckpoint)
      && syncShareOfCheckpoint <= thresholds.checkpointSyncShareOfCheckpoint
      && checkpoint.timeShareOfWindow <= thresholds.checkpointPacingMaximumTimeShare;
    const evidence = {
      checkpointTimeMs: checkpoint.totalTimeMs,
      checkpointTimeShareOfWindow: checkpoint.timeShareOfWindow,
      thresholdTimeMs: thresholds.minimumCheckpointTimeMs,
      thresholdShare: thresholds.checkpointTimeShareOfWindow,
      pacingMaximumShare: thresholds.checkpointPacingMaximumTimeShare,
      requested: checkpoint.requested,
      timed: checkpoint.timed,
      writeTimeMs,
      syncTimeMs,
      syncShareOfCheckpoint,
      syncShareThreshold: thresholds.checkpointSyncShareOfCheckpoint,
      dominantPhase,
      buffers,
      writeTimePerBufferMs,
      walBytes: summary.wal?.bytes ?? null,
      walBytesPerRequest,
      configuration: summary.configuration ?? null
    };
    if (checkpointPaced) {
      return {
        passed: true,
        classification: "checkpoint-paced",
        reason: `PostgreSQL timed checkpoints were deliberately paced (${percentage(checkpoint.timeShareOfWindow)}% of the window) without requested checkpoints or material sync time; HTTP SLOs still passed.`,
        actions: [
          "Keep checkpoint timing and effective PostgreSQL configuration with the evidence package.",
          "Investigate only if future windows also show requested checkpoints, sync pressure, or an SLO regression."
        ],
        evidence
      };
    }
    return acceptanceFailure(
      "storage-blocking",
      `PostgreSQL checkpoint ${dominantPhase} time consumed ${percentage(checkpoint.timeShareOfWindow)}% of the measured window without sufficient evidence of normal pacing.`,
      [
        "Inspect checkpoint requested/timed counts, WAL bytes, and independent storage latency in postgresTelemetry.summary.",
        "Have the database owner review checkpoint cadence, WAL budget, checkpoint completion pacing, and storage throughput before changing PREMiSE code.",
        "Repeat the soak after the database-side investigation and compare each operation's p95/p99 latency."
      ],
      evidence
    );
  }

  return {
    passed: true,
    classification: "accepted",
    reason: "The measured operations completed without HTTP errors and PostgreSQL checkpoint time did not dominate the evidence window.",
    actions: [],
    evidence: {
      checkpointTimeMs: checkpoint?.totalTimeMs ?? null,
      checkpointTimeShareOfWindow: checkpoint?.timeShareOfWindow ?? null,
      peakConnectionUtilization: connectionUtilization ?? null,
      configuration: summary.configuration ?? null
    }
  };
}

function createSampler(telemetry, intervalMs, timeoutMs) {
  const samples = [];
  const errors = [];
  let stopped = false;
  let ended = false;
  let poller = Promise.resolve();
  let timer;
  let wake;

  async function capture() {
    const started = performance.now();
    let timer;
    try {
      const sample = await Promise.race([
        telemetry.snapshot(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`PostgreSQL telemetry timed out after ${timeoutMs} ms`)), timeoutMs);
        })
      ]);
      if (sample?.format !== POSTGRES_TELEMETRY_FORMAT) throw new Error(`unexpected PostgreSQL telemetry format: ${sample?.format ?? "missing"}`);
      samples.push(sample);
    } catch (error) {
      errors.push({ ...errorEntry(error), capturedAt: new Date().toISOString(), durationMs: Number((performance.now() - started).toFixed(3)) });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    samples,
    errors,
    async start() {
      await capture();
      poller = (async () => {
        while (!stopped) {
          await new Promise((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, intervalMs);
          });
          timer = undefined;
          wake = undefined;
          if (stopped) break;
          await capture();
        }
      })();
    },
    async end() {
      if (ended) return;
      ended = true;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      wake?.();
      await poller;
      await capture();
    }
  };
}

export function parseArgs(argv = process.argv.slice(2), environment = process.env) {
  const forwarded = [];
  let telemetryIntervalMs = positiveInteger(environment.PREMISE_SOAK_PG_TELEMETRY_INTERVAL_MS ?? DEFAULT_TELEMETRY_INTERVAL_MS, "PREMISE_SOAK_PG_TELEMETRY_INTERVAL_MS");
  let telemetryTimeoutMs = positiveInteger(environment.PREMISE_SOAK_PG_TELEMETRY_TIMEOUT_MS ?? DEFAULT_TELEMETRY_TIMEOUT_MS, "PREMISE_SOAK_PG_TELEMETRY_TIMEOUT_MS");
  let enforceAcceptance = environment.PREMISE_SOAK_ENFORCE_ACCEPTANCE !== "0";
  let diagnosticOutput = environment.PREMISE_SOAK_DIAGNOSTIC_OUTPUT === undefined ? DEFAULT_OUTPUT : path.resolve(environment.PREMISE_SOAK_DIAGNOSTIC_OUTPUT);
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (flag === "--telemetry-interval-ms") {
      const value = inlineValue ?? argumentValue(argv, index, flag);
      if (inlineValue === undefined) index += 1;
      telemetryIntervalMs = positiveInteger(value, flag);
      continue;
    }
    if (flag === "--telemetry-timeout-ms") {
      const value = inlineValue ?? argumentValue(argv, index, flag);
      if (inlineValue === undefined) index += 1;
      telemetryTimeoutMs = positiveInteger(value, flag);
      continue;
    }
    if (flag === "--enforce-acceptance") {
      enforceAcceptance = true;
      continue;
    }
    if (flag === "--report-only") {
      enforceAcceptance = false;
      continue;
    }
    if (flag === "--output") {
      const value = inlineValue ?? argumentValue(argv, index, flag);
      if (inlineValue === undefined) {
        forwarded.push(argument, value);
        index += 1;
      } else {
        forwarded.push(argument);
      }
      diagnosticOutput = path.resolve(value);
      continue;
    }
    if (flag === "--help" || flag === "-h") help = true;
    forwarded.push(argument);
  }

  const parsed = parseSoakArgs(forwarded, environment);
  return {
    help: help || parsed.help,
    config: parsed.config === undefined ? undefined : {
      ...parsed.config,
      output: null,
      diagnosticOutput,
      telemetryIntervalMs,
      telemetryTimeoutMs,
      enforceAcceptance
    }
  };
}

export function help() {
  return `Usage: node benchmarks/ga-soak/diagnostic.mjs [soak options]

Runs the HTTP soak with read-only PostgreSQL checkpoint, WAL, database, and connection telemetry.
The check exits non-zero for incomplete telemetry, real storage blocking, connection saturation, HTTP errors, or p95/p99 above the GA limits.
Options:
  --telemetry-interval-ms N     PostgreSQL sample interval (default: 1000)
  --telemetry-timeout-ms N      timeout for each PostgreSQL sample (default: 5000)
  --enforce-acceptance           fail on an acceptance classification (default)
  --report-only                 write the result without failing the process
  --output PATH                 diagnostic result JSON path
  --help`;
}

export async function runDiagnostic(input = {}) {
  const intervalMs = positiveInteger(input.telemetryIntervalMs ?? DEFAULT_TELEMETRY_INTERVAL_MS, "telemetryIntervalMs");
  let telemetry = input.telemetry;
  let ownedTelemetry = false;
  const openErrors = [];
  if (telemetry === undefined) {
    try {
      telemetry = await openPostgresTelemetry({ connectionString: input.databaseUrl ?? databaseUrl(), timeoutMs: input.telemetryTimeoutMs ?? DEFAULT_TELEMETRY_TIMEOUT_MS });
      ownedTelemetry = true;
    } catch (error) {
      openErrors.push(errorEntry(error, "telemetry-unavailable"));
    }
  }

  const sampler = telemetry === undefined ? undefined : createSampler(telemetry, intervalMs, positiveInteger(input.telemetryTimeoutMs ?? DEFAULT_TELEMETRY_TIMEOUT_MS, "telemetryTimeoutMs"));
  let soak;
  try {
    soak = await runSoak({
      ...input,
      output: null,
      measuredWindow: sampler === undefined ? undefined : sampler
    });
  } finally {
    if (sampler !== undefined) await sampler.end();
    if (ownedTelemetry) {
      try {
        await telemetry.close();
      } catch (error) {
        sampler?.errors.push(errorEntry(error, "telemetry-close-failed"));
      }
    }
  }

  const samples = sampler?.samples ?? [];
  const errors = [...openErrors, ...(sampler?.errors ?? [])];
  const summary = summarizePostgresTelemetry(samples, soak.window.activeDurationMs);
  const postgresTelemetry = {
    schema: POSTGRES_TELEMETRY_FORMAT,
    available: summary.available === true && errors.length === 0,
    sampleIntervalMs: intervalMs,
    sampleTimeoutMs: input.telemetryTimeoutMs ?? DEFAULT_TELEMETRY_TIMEOUT_MS,
    sampleCount: samples.length,
    database: samples[0]?.database ?? null,
    serverVersionNum: samples[0]?.serverVersionNum ?? null,
    samples,
    summary,
    errors
  };
  const acceptance = classifyAcceptance(soak, postgresTelemetry);
  const eligibility = acceptance.passed
    ? soak.eligibility
    : {
      ...soak.eligibility,
      eligibleForGa: false,
      classification: "ga-candidate-failed",
      reasons: [...new Set([...(soak.eligibility.reasons ?? []), "acceptance"])],
      checks: {
        ...soak.eligibility.checks,
        acceptance: {
          observed: acceptance.classification,
          passed: false
        }
      },
      note: "Diagnostic acceptance is part of GA eligibility; a failed PostgreSQL or semantic acceptance check cannot coexist with ga-eligible."
    };
  const result = {
    ...soak,
    schema: DIAGNOSTIC_FORMAT,
    format: DIAGNOSTIC_FORMAT,
    benchmark: "ga-soak-diagnostic",
    soakFormat: soak.format,
    postgresTelemetry,
    acceptance,
    eligibility
  };
  const output = input.diagnosticOutput === undefined ? input.output : input.diagnosticOutput;
  if (output !== null && output !== undefined) {
    await mkdir(path.dirname(path.resolve(String(output))), { recursive: true });
    await writeFile(path.resolve(String(output)), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

async function main() {
  const parsed = parseArgs();
  if (parsed.help) {
    console.log(help());
    return;
  }
  const result = await runDiagnostic(parsed.config);
  const acceptanceFailed = !result.acceptance.passed;
  const gaFailed = parsed.config.enforceGa && !result.eligibility.eligibleForGa;
  console.log(JSON.stringify({
    status: acceptanceFailed || gaFailed ? "FAIL" : "PASS",
    classification: result.acceptance.classification,
    reason: result.acceptance.reason,
    actions: result.acceptance.actions,
    gaEligible: result.eligibility.eligibleForGa,
    requests: result.metrics.requests,
    p95Ms: result.metrics.latency.p95Ms,
    checkpointTimeMs: result.acceptance.evidence.checkpointTimeMs ?? null,
    output: parsed.config.diagnosticOutput
  }, null, 2));
  if ((parsed.config.enforceAcceptance && acceptanceFailed) || gaFailed) process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
