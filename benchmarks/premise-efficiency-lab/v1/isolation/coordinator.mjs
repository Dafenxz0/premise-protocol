import { spawn } from "node:child_process";
import { canonicalJson } from "./hash.mjs";
import {
  ISOLATION_PROTOCOL,
  MAX_NDJSON_LINE_BYTES,
  IsolationProtocolError,
  encodeNdjson,
  parseNdjson,
  validateCandidateInputRecord,
  validateCandidateOutputRecord,
  validatePublicPayload
} from "./protocol.mjs";

export const DEFAULT_CANDIDATE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class CandidateProcessError extends Error {
  constructor(message, code = "CANDIDATE_PROCESS_FAILED", details = undefined) {
    super(`[efficiency-lab-candidate] ${message}`);
    this.name = "CandidateProcessError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function positiveInteger(value, label, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return result;
}

function cloneJson(value, label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be JSON-compatible: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function commandSpec(options) {
  let command = options.command ?? options.candidateCommand;
  let args = options.args ?? [];
  if (Array.isArray(command)) {
    args = [...command.slice(1), ...args];
    command = command[0];
  }
  if (typeof command !== "string" || command.length === 0) throw new TypeError("command must be a non-empty executable path");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new TypeError("args must be an array of strings");
  return { command, args };
}

function cleanEnvironment(options) {
  const inherited = options.inheritEnvironment === true ? process.env : {
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec
  };
  const environment = { ...inherited, ...(options.env ?? {}) };
  for (const key of Object.keys(environment)) {
    if (/^(ORACLE|TRUTH|GROUND|PRIVATE|MUTATION|ANSWER|GOLD|EXPECTED|GITHUB_TOKEN|DATABASE_URL|OPENROUTER_API_KEY|ZAI_API_KEY)/iu.test(key)) {
      delete environment[key];
    }
  }
  return environment;
}

function candidateInput(options, publicPayload) {
  const input = {
    protocol: ISOLATION_PROTOCOL,
    type: "task",
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    public: publicPayload
  };
  validateCandidateInputRecord(input);
  return input;
}

function collectChildOutput(child, options) {
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, "maxOutputBytes", DEFAULT_MAX_OUTPUT_BYTES);
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let outputLimitError;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    outputBytes += Buffer.byteLength(chunk, "utf8");
    if (outputBytes > maxOutputBytes) {
      outputLimitError ??= new CandidateProcessError(`candidate output exceeds ${maxOutputBytes} bytes`, "OUTPUT_TOO_LARGE");
      child.kill();
      return;
    }
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    if (Buffer.byteLength(stderr, "utf8") < maxOutputBytes) stderr += chunk;
  });
  return {
    read: () => ({ stdout, stderr, outputLimitError })
  };
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new CandidateProcessError(`candidate timed out after ${timeoutMs}ms`, "TIMEOUT"));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CandidateProcessError(error.message, "SPAWN_ERROR", { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Execute one candidate with a public-only NDJSON input. */
export async function runCandidate(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("candidate options must be an object");
  const { command, args } = commandSpec(options);
  const publicSource = options.publicPayload ?? options.public;
  validatePublicPayload(publicSource);
  const publicPayload = cloneJson(publicSource, "public payload");
  const input = candidateInput(options, publicPayload);
  const timeoutMs = positiveInteger(options.timeoutMs, "timeoutMs", DEFAULT_CANDIDATE_TIMEOUT_MS);
  const maxLineBytes = positiveInteger(options.maxLineBytes, "maxLineBytes", MAX_NDJSON_LINE_BYTES);

  let child;
  try {
    child = spawn(command, args, {
      shell: false,
      cwd: options.cwd ?? process.cwd(),
      env: cleanEnvironment(options),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
  } catch (error) {
    throw new CandidateProcessError(error instanceof Error ? error.message : String(error), "SPAWN_ERROR");
  }

  const output = collectChildOutput(child, options);
  const inputLine = encodeNdjson(input, { maxLineBytes, validate: validateCandidateInputRecord });
  child.stdin.on("error", () => {});
  child.stdin.end(inputLine);

  let exit;
  try {
    exit = await waitForChild(child, timeoutMs);
  } catch (error) {
    throw error;
  }

  const captured = output.read();
  if (captured.outputLimitError) throw captured.outputLimitError;
  if (exit.code !== 0) {
    throw new CandidateProcessError(
      `candidate exited with ${exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`}`,
      "NONZERO_EXIT",
      { exit, stderr: captured.stderr.slice(0, 4_096) }
    );
  }

  let records;
  try {
    records = parseNdjson(captured.stdout, {
      maxLineBytes,
      maxRecords: options.maxRecords,
      validate: validateCandidateOutputRecord
    });
  } catch (error) {
    if (error instanceof IsolationProtocolError) {
      throw new CandidateProcessError(error.message, error.code, { cause: error, stderr: captured.stderr.slice(0, 4_096) });
    }
    throw error;
  }
  if (records.length === 0) throw new CandidateProcessError("candidate produced no NDJSON records", "EMPTY_OUTPUT");
  const plans = records.filter((record) => record.type === "plan" || record.type === "result" || !Object.hasOwn(record, "type"));
  if (plans.length === 0) throw new CandidateProcessError("candidate produced no plan", "PLAN_MISSING");
  const planRecord = plans.at(-1);
  const plan = planRecord.type === "plan" || planRecord.type === "result" ? planRecord.plan ?? planRecord : planRecord;
  return Object.freeze({
    protocol: ISOLATION_PROTOCOL,
    publicPayload,
    records: Object.freeze(records),
    plan,
    stderr: captured.stderr.slice(0, 4_096),
    exitCode: exit.code,
    signal: exit.signal
  });
}

export const executeCandidate = runCandidate;

/** Run the candidate first, then optionally hand private truth to a referee callback in the parent. */
export async function coordinate(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("coordinator options must be an object");
  const privateSource = options.privatePayload ?? options.private;
  const privatePayload = privateSource === undefined ? undefined : cloneJson(privateSource, "private payload");
  const candidate = await runCandidate(options);
  if (typeof options.oracle !== "function") return Object.freeze({ candidate, privatePayload });
  const oracleInput = {
    privatePayload: privatePayload === undefined ? undefined : cloneJson(privatePayload, "private payload"),
    candidate: cloneJson({ records: candidate.records, plan: candidate.plan }, "candidate result")
  };
  const oracle = await options.oracle(oracleInput);
  return Object.freeze({ candidate, privatePayload, oracle });
}

export const runCoordinator = coordinate;
