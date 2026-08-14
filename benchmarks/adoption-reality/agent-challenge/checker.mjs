import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const DEFAULT_MANIFEST = join(ROOT, "prompt-manifest.json");
const DEFAULT_INPUT = join(ROOT, "fixtures", "isolated-agent");
const DEFAULT_CANDIDATE = join(ROOT, "fixtures", "reference-run");
const TRACE_FILE = "run.json";
const PUBLIC_PACKAGE = "@premise/sdk";
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".jsx", ".ts", ".tsx"]);
const DOC_PATH = /^(?:README\.md|docs\/[^/]+\.md)$/u;
const FORBIDDEN_KEY = /^(?:answer|answerkey|expected|gold|goldanswer|groundtruth|oracle|snapshot)$/iu;
const FORBIDDEN_CONTENT = /\b(?:answer\s*key|expected\s*answer|gold\s*answer|ground\s*truth|oracle)\b/iu;
const CREDENTIAL_LITERAL = /\b(?:Bearer\s+[A-Za-z0-9._~-]{12,}|(?:sk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{10,})\b/iu;
const IMPORT_PATTERNS = [
  /\bimport\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/gu,
  /\bexport\s+[\s\S]*?\sfrom\s+["']([^"']+)["']/gu,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu
];

function asRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function filesUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, absolute));
    else files.push(asRelative(root, absolute));
  }
  return files.sort();
}

async function textAt(root, path) {
  return readFile(join(root, ...path.split("/")), "utf8");
}

async function jsonAt(root, path) {
  return JSON.parse(await textAt(root, path));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectForbiddenKeys(value, path = "$") {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...collectForbiddenKeys(item, `${path}[${index}]`)));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) found.push(`${path}.${key}`);
    found.push(...collectForbiddenKeys(child, `${path}.${key}`));
  }
  return found;
}

function importSpecifiers(source) {
  const result = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) result.add(match[1]);
  }
  return [...result].sort();
}

function isInternalSpecifier(specifier) {
  const value = specifier.replaceAll("\\", "/");
  return value.startsWith("workspace:")
    || (value.startsWith("@premise/") && value !== PUBLIC_PACKAGE)
    || value.startsWith("../")
    || value.startsWith("file:")
    || value.includes("/packages/")
    || value.includes("/node_modules/@premise/")
    || /^(?:packages|\.agents|plugins|benchmarks)(?:\/|$)/u.test(value);
}

function isSourceFile(path) {
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function isAllowedInputPath(path, allowedFiles) {
  return allowedFiles.includes(path) && DOC_PATH.test(path) || path === "package.json";
}

function baseResult() {
  return {
    format: "premise-agent-integration-result/1",
    status: "FAIL",
    success: false,
    filesChanged: [],
    filesChangedCount: 0,
    internalImports: [],
    internalImportCount: 0,
    docsReads: [],
    docsReadCount: 0,
    packageReads: [],
    publicReads: [],
    errors: [],
    errorCount: 0,
    timeToFirstSuccessMs: null,
    credentialsUsed: false,
    agentLaunched: false,
    deterministic: true,
    metrics: {}
  };
}

function finish(result) {
  result.success = result.errors.length === 0 && result.success === true;
  result.status = result.success ? "PASS" : "FAIL";
  result.filesChangedCount = result.filesChanged.length;
  result.internalImportCount = result.internalImports.length;
  result.docsReadCount = result.docsReads.length;
  result.errorCount = result.errors.length;
  result.metrics = {
    success: result.success,
    filesChanged: result.filesChanged,
    internalImports: result.internalImports,
    docsReads: result.docsReads,
    errors: result.errors,
    timeToFirstSuccessMs: result.timeToFirstSuccessMs
  };
  return result;
}

function addErrors(result, errors) {
  result.errors = uniqueSorted([...result.errors, ...errors]);
}

async function validateInput(inputRoot, manifest, result) {
  let files;
  try {
    files = await filesUnder(inputRoot);
  } catch (error) {
    addErrors(result, [`input could not be read: ${error.message}`]);
    return [];
  }

  const allowed = manifest?.input?.allowedFiles ?? [];
  addErrors(result, files.filter((file) => !allowed.includes(file)).map((file) => `input exposes non-public file: ${file}`));
  addErrors(result, allowed.filter((file) => !files.includes(file)).map((file) => `input is missing public file: ${file}`));

  try {
    const packageJson = await jsonAt(inputRoot, "package.json");
    if (packageJson.private !== true) addErrors(result, ["input package must be private"]);
    if (packageJson.type !== "module") addErrors(result, ["input package must use ESM"]);
    if (packageJson.workspaces !== undefined) addErrors(result, ["input package exposes a workspace"]);
    const dependencies = packageJson.dependencies ?? {};
    const dependencyNames = Object.keys(dependencies);
    if (dependencyNames.length !== 1 || dependencyNames[0] !== PUBLIC_PACKAGE) addErrors(result, ["input package must depend only on the public SDK"]);
    if (Object.values(dependencies).some((version) => typeof version !== "string" || version.startsWith("workspace:"))) addErrors(result, ["input package contains a workspace dependency"]);
  } catch (error) {
    addErrors(result, [`input package.json is invalid: ${error.message}`]);
  }
  return files;
}

async function checkCandidate(candidateRoot, inputRoot, manifest, result) {
  let files;
  try {
    files = await filesUnder(candidateRoot);
  } catch (error) {
    addErrors(result, [`candidate could not be read: ${error.message}`]);
    return;
  }

  const changedFiles = files.filter((file) => file !== TRACE_FILE);
  result.filesChanged = changedFiles;
  if (changedFiles.length === 0) addErrors(result, ["candidate did not change a file"]);
  if (files.includes("prompt-manifest.json") || files.some((file) => file.startsWith("fixtures/"))) {
    addErrors(result, ["candidate includes evaluator files"]);
  }

  let trace;
  try {
    trace = await jsonAt(candidateRoot, TRACE_FILE);
  } catch (error) {
    addErrors(result, [`candidate trace is invalid: ${error.message}`]);
    trace = {};
  }

  if (trace.format !== "premise-agent-integration-trace/1") addErrors(result, ["candidate trace format is invalid"]);
  if (!Array.isArray(trace.filesChanged) || !equalJson(trace.filesChanged, changedFiles)) addErrors(result, ["trace filesChanged does not match the candidate"]);
  if (!Array.isArray(trace.internalImports)) addErrors(result, ["trace internalImports must be an array"]);
  if (!Array.isArray(trace.docsReads)) addErrors(result, ["trace docsReads must be an array"]);
  if (!Array.isArray(trace.errors)) addErrors(result, ["trace errors must be an array"]);
  if (trace.credentialsUsed === true) addErrors(result, ["candidate reports credential use"]);

  const sourceTexts = [];
  const internalImports = [];
  const contentErrors = [];
  let hasPublicImport = false;
  let hasClientUse = false;
  for (const file of files) {
    let content;
    try {
      content = await textAt(candidateRoot, file);
    } catch (error) {
      contentErrors.push(`${file} could not be read: ${error.message}`);
      continue;
    }
    if (FORBIDDEN_CONTENT.test(content)) contentErrors.push(`${file} contains evaluator-only answer data`);
    if (CREDENTIAL_LITERAL.test(content)) contentErrors.push(`${file} contains a credential literal`);
    if (isSourceFile(file) || file === "package.json") {
      sourceTexts.push(content);
      for (const specifier of importSpecifiers(content)) {
        if (specifier === PUBLIC_PACKAGE) hasPublicImport = true;
        if (isInternalSpecifier(specifier)) internalImports.push(`${file} -> ${specifier}`);
      }
      if (/\bPremiseClient\b/u.test(content)) hasClientUse = true;
    }
    if (file === "package.json") {
      try {
        const packageJson = JSON.parse(content);
        const dependencies = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
        for (const dependency of Object.keys(dependencies)) {
          if (dependency !== PUBLIC_PACKAGE) internalImports.push(`${file} dependency -> ${dependency}`);
          if (String(dependencies[dependency]).startsWith("workspace:")) internalImports.push(`${file} dependency -> ${dependency}@workspace`);
        }
      } catch (error) {
        contentErrors.push(`candidate package.json is invalid: ${error.message}`);
      }
    }
  }
  result.internalImports = uniqueSorted(internalImports);
  addErrors(result, contentErrors);
  if (result.internalImports.length > 0) addErrors(result, result.internalImports.map((entry) => `internal import: ${entry}`));
  if (!hasPublicImport) addErrors(result, [`candidate does not import ${PUBLIC_PACKAGE}`]);
  if (!hasClientUse) addErrors(result, ["candidate does not construct the public client"]);
  if (!sourceTexts.length) addErrors(result, ["candidate has no source file"]);

  const events = Array.isArray(trace.events) ? trace.events : [];
  const allowedFiles = manifest?.input?.allowedFiles ?? [];
  const publicReads = [];
  const docsReads = [];
  const packageReads = [];
  const eventErrors = [];
  let firstSuccess = null;
  for (const event of events) {
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      eventErrors.push("trace contains an invalid event");
      continue;
    }
    if (event.type === "read") {
      if (typeof event.path !== "string" || !isAllowedInputPath(event.path, allowedFiles)) {
        eventErrors.push(`trace read is outside the public input: ${String(event.path)}`);
        continue;
      }
      publicReads.push(event.path);
      if (event.path === "package.json") packageReads.push(event.path);
      else docsReads.push(event.path);
    } else if (event.type === "success") {
      if (!Number.isFinite(event.atMs) || event.atMs < 0) eventErrors.push("success event time is invalid");
      else if (firstSuccess === null) firstSuccess = event.atMs;
    } else if (event.type === "error") {
      if (typeof event.message !== "string" || event.message.trim() === "") eventErrors.push("error event message is invalid");
    } else {
      eventErrors.push(`unknown trace event: ${event.type}`);
    }
  }
  result.publicReads = uniqueSorted(publicReads);
  result.docsReads = uniqueSorted(docsReads);
  result.packageReads = uniqueSorted(packageReads);
  addErrors(result, eventErrors);
  if (result.docsReads.length === 0) addErrors(result, ["candidate did not read public documentation"]);
  if (!Array.isArray(trace.docsReads) || !equalJson(trace.docsReads, result.docsReads)) addErrors(result, ["trace docsReads does not match read events"]);
  const reportedTime = trace.timeToFirstSuccessMs;
  if (reportedTime !== firstSuccess) addErrors(result, ["trace timeToFirstSuccessMs does not match the first success event"]);
  result.timeToFirstSuccessMs = firstSuccess;
  if (firstSuccess === null) addErrors(result, ["candidate has no success event"]);

  const reportedErrors = Array.isArray(trace.errors) ? trace.errors.filter((error) => typeof error === "string" && error.trim() !== "") : [];
  addErrors(result, reportedErrors.map((error) => `agent error: ${error}`));
  if (trace.success !== true) addErrors(result, ["candidate trace does not report success"]);
}

async function checkManifest(manifestPath, manifest, result) {
  if (manifest?.format !== "premise-agent-integration-prompt-manifest/1") addErrors(result, ["prompt manifest format is invalid"]);
  if (manifest?.input?.publicOnly !== true || manifest?.input?.network !== false || manifest?.input?.credentials !== false) {
    addErrors(result, ["prompt manifest does not freeze a public, offline, credential-free input"]);
  }
  const allowedFiles = manifest?.input?.allowedFiles;
  if (!Array.isArray(allowedFiles) || new Set(allowedFiles).size !== allowedFiles.length || allowedFiles.some((path) => !isAllowedInputPath(path, allowedFiles))) {
    addErrors(result, ["prompt manifest expands the public input surface"]);
  }
  const forbiddenKeys = collectForbiddenKeys(manifest);
  if (forbiddenKeys.length) addErrors(result, forbiddenKeys.map((path) => `prompt manifest contains a private-answer field at ${path}`));
  if (FORBIDDEN_CONTENT.test(JSON.stringify(manifest))) addErrors(result, ["prompt manifest contains evaluator answer data"]);
  if (typeof manifestPath !== "string" || manifestPath.length === 0) addErrors(result, ["prompt manifest path is empty"]);
}

export async function checkChallenge({ manifestPath = DEFAULT_MANIFEST, inputRoot = DEFAULT_INPUT, candidateRoot = DEFAULT_CANDIDATE } = {}) {
  const result = baseResult();
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  } catch (error) {
    addErrors(result, [`prompt manifest is invalid: ${error.message}`]);
    return finish(result);
  }
  await checkManifest(manifestPath, manifest, result);
  const inputFiles = await validateInput(resolve(inputRoot), manifest, result);
  if (inputFiles.length > 0 && !equalJson(uniqueSorted(inputFiles), uniqueSorted(manifest?.input?.allowedFiles ?? []))) addErrors(result, ["input files are not frozen by the manifest"]);
  await checkCandidate(resolve(candidateRoot), resolve(inputRoot), manifest, result);
  result.success = result.errors.length === 0;
  return finish(result);
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

async function selfCheck() {
  const reference = await checkChallenge();
  assert.equal(reference.status, "PASS", JSON.stringify(reference, null, 2));
  assert.equal(reference.success, true);
  assert.deepEqual(reference.internalImports, []);
  assert.deepEqual(reference.errors, []);
  assert.equal(reference.agentLaunched, false);
  assert.equal(reference.credentialsUsed, false);
  assert.equal(reference.deterministic, true);
  assert.equal(reference.timeToFirstSuccessMs, 37);
  assert.deepEqual(reference.metrics.filesChanged, ["agent.mjs"]);

  const rejected = await checkChallenge({ candidateRoot: join(ROOT, "fixtures", "rejected-internal") });
  assert.equal(rejected.status, "FAIL");
  assert.equal(rejected.success, false);
  assert.ok(rejected.internalImports.some((entry) => entry.includes("@premise/runtime-core")));
  assert.ok(rejected.errors.some((error) => error.includes("internal import")));
  console.log(JSON.stringify({ status: "PASS", reference, rejectedInternal: rejected }, null, 2));
}

const args = process.argv.slice(2);
if (args.includes("--self-check")) {
  await selfCheck();
} else if (args.includes("--help")) {
  console.log("Usage: node checker.mjs [--candidate DIR] [--input DIR] [--manifest FILE]");
} else {
  const manifestPath = optionValue(args, "--manifest", DEFAULT_MANIFEST);
  const inputRoot = optionValue(args, "--input", DEFAULT_INPUT);
  const candidateRoot = optionValue(args, "--candidate", DEFAULT_CANDIDATE);
  const result = await checkChallenge({ manifestPath, inputRoot, candidateRoot });
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
}
