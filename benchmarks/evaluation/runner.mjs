import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evaluationDir = join(root, "benchmarks", "evaluation");
const currentCli = join(root, "benchmarks", "premise-memory-bench", "dist", "cli.js");
const scenarioRoots = [
  ["filesystem", join(root, "benchmarks", "premise-memory-bench", "scenarios", "filesystem", "scenarios.json")],
  ["git", join(root, "benchmarks", "premise-memory-bench", "scenarios", "git", "scenarios.json")],
  ["github-like", join(root, "benchmarks", "premise-memory-bench", "scenarios", "github-like", "scenarios.json")]
];
const controlFile = join(root, "benchmarks", "premise-memory-bench", "static-controls", "controls.json");
const ablationFile = join(root, "benchmarks", "premise-memory-bench", "ablations", "ablations.json");
const sourceFiles = [
  join(root, "benchmarks", "premise-memory-bench", "src", "cli.ts"),
  join(root, "benchmarks", "premise-memory-bench", "src", "engine", "index.ts"),
  join(root, "benchmarks", "premise-memory-bench", "src", "evaluators", "index.ts"),
  join(root, "benchmarks", "premise-memory-bench", "src", "baselines", "index.ts")
];
const externalBenchmarkNames = ["comparative-bench", "long-context-bench", "real-world-bench", "context-corpus-bench"];

const thresholds = {
  safety: { maxUnsafeActionRate: 0, maxIncreasePp: 0.005 },
  recovery: { minRepairSuccessRate: 0.95, maxDropPp: 0.05 },
  falseRejects: { maxIncreasePp: 0.02, staticControlPassRate: 1 },
  rereadCost: { maxIncreasePct: 0.10, maxExtraCallsPerEpisode: 0.10 },
  latency: { maxIncreasePct: 0.20, maxIncreaseMs: 50 },
  memory: { maxIncreasePct: 0.15, maxIncreaseBytes: 4096 },
  history: { maxDropPp: 0.02 }
};

const metricAliases = new Map([
  ["unsafeactionrate", "unsafeActionRate"],
  ["actionsafetyrate", "actionSafetyRate"],
  ["safetyrate", "actionSafetyRate"],
  ["stalerecallrate", "staleRecallRate"],
  ["staleactionrate", "staleActionRate"],
  ["dynamicmemoryrepairrate", "dynamicMemoryRepairRate"],
  ["tasksuccessrate", "taskSuccessRate"],
  ["successrate", "successRate"],
  ["falserejectionrate", "falseRejectionRate"],
  ["correctdecisionrate", "correctDecisionRate"],
  ["saferecoveryrate", "safeRecoveryRate"],
  ["validatedrecoveryrate", "validatedRecoveryRate"],
  ["resultmatchrate", "resultMatchRate"],
  ["protocolvalidatecalls", "protocolValidateCalls"],
  ["memoryreadcalls", "memoryReadCalls"],
  ["preservationrate", "preservationRate"],
  ["isolationpassrate", "isolationPassRate"],
  ["averagetargetevents", "averageTargetEvents"],
  ["totaltargetevents", "totalTargetEvents"],
  ["episodeswithhistory", "episodesWithHistory"],
  ["versionfor", "versionForCalls"],
  ["validate", "validateCalls"],
  ["p50", "p50"],
  ["p95", "p95"],
  ["accuracy", "accuracy"],
  ["precision", "precision"],
  ["recall", "recall"],
  ["f1", "f1Score"],
  ["f1score", "f1Score"],
  ["answeraccuracy", "answerAccuracy"],
  ["citationaccuracy", "citationAccuracy"],
  ["retrievalprecision", "retrievalPrecision"],
  ["retrievalrecall", "retrievalRecall"],
  ["retrievalhitrate", "retrievalHitRate"],
  ["contextprecision", "contextPrecision"],
  ["contextrecall", "contextRecall"],
  ["groundingrate", "groundingRate"],
  ["safety", "safety"],
  ["coverage", "coverage"],
  ["repairrate", "repairSuccessRate"],
  ["repairsuccessrate", "repairSuccessRate"],
  ["recoveryrate", "recoveryRate"],
  ["revalidationcalls", "revalidationCalls"],
  ["rereadcalls", "revalidationCalls"],
  ["avgrevalidationcalls", "revalidationCallsPerEpisode"],
  ["revalidationcallsperepisode", "revalidationCallsPerEpisode"],
  ["falserejectrate", "falseRejectRate"],
  ["falsesuppressionrate", "falseRejectRate"],
  ["historypreservationrate", "historyPreservationRate"],
  ["latencyp50ms", "latencyP50Ms"],
  ["p50latencyms", "latencyP50Ms"],
  ["latencyp95ms", "latencyP95Ms"],
  ["p95latencyms", "latencyP95Ms"],
  ["memoryp50bytes", "memoryP50Bytes"],
  ["p50memorybytes", "memoryP50Bytes"],
  ["memoryp95bytes", "memoryP95Bytes"],
  ["p95memorybytes", "memoryP95Bytes"],
  ["registerms", "registerMs"],
  ["derivems", "deriveMs"],
  ["checkms", "checkMs"],
  ["signalms", "signalMs"],
  ["validatems", "validateMs"],
  ["totalms", "totalMs"],
  ["heapdeltabytes", "heapDeltaBytes"],
  ["serializedmetadatabytes", "serializedMetadataBytes"],
  ["externalpayloadbytes", "externalPayloadBytes"]
]);

const denominatorAliases = new Map([
  ["count", "count"],
  ["total", "total"],
  ["episodes", "episodes"],
  ["episodecount", "episodes"],
  ["scenarios", "scenarios"],
  ["scenariocount", "scenarios"],
  ["tasks", "tasks"],
  ["taskcount", "tasks"],
  ["cases", "cases"],
  ["casecount", "cases"],
  ["examples", "examples"],
  ["examplecount", "examples"],
  ["documents", "documents"],
  ["documentcount", "documents"],
  ["chunks", "chunks"],
  ["chunkcount", "chunks"],
  ["queries", "queries"],
  ["querycount", "queries"],
  ["samples", "samples"],
  ["samplecount", "samples"],
  ["records", "records"],
  ["recordcount", "records"],
  ["nodes", "nodes"],
  ["nodecount", "nodes"],
  ["tokens", "tokens"],
  ["tokencount", "tokens"],
  ["controls", "controls"],
  ["controlcount", "controls"],
  ["ablations", "ablations"],
  ["ablationcount", "ablations"]
]);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function command(commandName, args, cwd) {
  return new Promise((resolveCommand) => {
    const child = spawn(commandName, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => resolveCommand({ code: -1, stdout: stdout.join(""), stderr: `${stderr.join("")}\n${error.message}` }));
    child.on("close", (code) => resolveCommand({ code: code ?? -1, stdout: stdout.join(""), stderr: stderr.join("") }));
  });
}

function parseJsonOutput(output) {
  const text = output.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("La salida del benchmark no contiene JSON parseable");
  }
}

async function captureV01() {
  const input = argValue("--v01-input");
  if (input) {
    try {
      return { available: true, source: input, command: null, result: await readJson(resolve(root, input)) };
    } catch (error) {
      return { available: false, source: input, command: null, error: error.message };
    }
  }
  if (!await exists(currentCli)) {
    return { available: false, source: "benchmarks/premise-memory-bench/dist/cli.js", command: null, error: "No existe el CLI compilado; usa --v01-input o compila el benchmark fuera de este runner." };
  }
  const args = [currentCli, "--runner", "minimal", "--suite", "v0.1"];
  const executed = await command(process.execPath, args, root);
  if (executed.code !== 0) {
    return { available: false, source: "benchmarks/premise-memory-bench/dist/cli.js", command: `${process.execPath} ${args.join(" ")}`, exitCode: executed.code, stderr: executed.stderr };
  }
  try {
    return { available: true, source: "benchmarks/premise-memory-bench/dist/cli.js", command: `${process.execPath} ${args.join(" ")}`, result: parseJsonOutput(executed.stdout) };
  } catch (error) {
    return { available: false, source: "benchmarks/premise-memory-bench/dist/cli.js", command: `${process.execPath} ${args.join(" ")}`, error: error.message, stdout: executed.stdout.slice(-2000), stderr: executed.stderr };
  }
}

function relativePath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function normalizedMetricKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function flattenMetrics(value, output = {}) {
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "number" && Number.isFinite(child)) {
      const alias = metricAliases.get(normalizedMetricKey(key));
      if (alias) output[alias] = child;
    } else if (child && typeof child === "object" && !["denominator", "denominators"].includes(normalizedMetricKey(key))) flattenMetrics(child, output);
  }
  return output;
}

function flattenDenominators(value, output = {}, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "number" && Number.isFinite(child)) output[path] = child;
    else if (child && typeof child === "object") flattenDenominators(child, output, path);
  }
  return output;
}

function collectDenominators(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const denominators = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedMetricKey(key);
    const alias = denominatorAliases.get(normalized);
    if (alias && typeof child === "number" && Number.isFinite(child)) denominators[alias] = child;
    if (["denominator", "denominators"].includes(normalized) && child && typeof child === "object") {
      Object.assign(denominators, flattenDenominators(child));
    }
  }
  return denominators;
}

function collectRows(value, path = "$", rows = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectRows(entry, `${path}[${index}]`, rows));
    return rows;
  }
  if (!value || typeof value !== "object") return rows;
  const metrics = flattenMetrics(value);
  if (Object.keys(metrics).length > 0) {
    const label = value.baseline ?? value.strategy ?? value.model ?? value.variant ?? value.name ?? value.label ?? value.profile ?? value.id ?? path;
    rows.push({ path, label: String(label), metrics, denominators: collectDenominators(value) });
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object" && !["denominator", "denominators"].includes(normalizedMetricKey(key))) collectRows(child, `${path}.${key}`, rows);
  }
  return rows;
}

async function externalSource(name) {
  const directoryCandidates = [join(root, "benchmarks", name), join(root, name)];
  const fileCandidates = [join(root, "benchmarks", `${name}.json`), join(root, `${name}.json`)];
  const directories = [];
  for (const candidate of directoryCandidates) if (await exists(candidate) && (await stat(candidate)).isDirectory()) directories.push(candidate);
  const files = [];
  for (const candidate of fileCandidates) if (await exists(candidate) && (await stat(candidate)).isFile()) files.push(candidate);
  for (const directory of directories) files.push(...(await walk(directory)).filter((path) => /\.(json|jsonl|ndjson)$/i.test(path)));
  const uniqueFiles = [...new Set(files)].sort();
  if (uniqueFiles.length === 0) {
    return { name, status: "absent", directories: directories.map(relativePath), files: [], recognizedRows: [], recognizedMetricNames: [], denominatorScopes: [], limitation: `No se encontró ${name}; no hay comparación externa disponible.` };
  }
  const parsedFiles = [];
  const recognizedRows = [];
  for (const path of uniqueFiles) {
    const bytes = await readFile(path);
    const file = { path: relativePath(path), bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    try {
      const raw = path.endsWith(".json") ? JSON.parse(bytes.toString("utf8")) : bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      file.status = "parsed";
      file.format = raw?.format ?? null;
      parsedFiles.push(file);
      for (const row of collectRows(raw)) recognizedRows.push({ file: file.path, ...row });
    } catch (error) {
      parsedFiles.push({ ...file, status: "invalid", error: error.message });
    }
  }
  return {
    name,
    status: "present",
    directories: directories.map(relativePath),
    files: parsedFiles,
    recognizedRows,
    recognizedMetricNames: [...new Set(recognizedRows.flatMap((row) => Object.keys(row.metrics)))].sort(),
    denominatorScopes: recognizedRows.filter((row) => Object.keys(row.denominators).length > 0).map((row) => ({ path: row.path, label: row.label, denominators: row.denominators })),
    limitation: recognizedRows.length === 0 ? "Los ficheros existen, pero no contienen métricas reconocibles por este adaptador; se conserva su hash y estado." : null
  };
}

function check(id, status, summary, evidence = {}) {
  return { id, status, summary, evidence };
}

function scenarioExpectation(scenario) {
  const expected = scenario.expected;
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (expected.afterRepair === "FRESH") return { change: expected.afterChange ?? "UNKNOWN", state: "REPAIRABLE", action: "REVALIDATE_THEN_USE" };
    if (expected.check === "REJECT") return { change: expected.afterChange ?? "INVALID", state: "NON_REPAIRABLE", action: "REJECT" };
    if (expected.afterChange === "STALE") return { change: "STALE", state: "REPAIRABLE", action: "REVALIDATE_THEN_USE" };
    if (expected.afterChange === "INVALID") return { change: "INVALID", state: "NON_REPAIRABLE", action: "REJECT" };
  }
  if (expected === "STALE") return { change: "STALE", state: "REPAIRABLE", action: "REVALIDATE_THEN_USE" };
  if (expected === "INVALID") return { change: "INVALID", state: "NON_REPAIRABLE", action: "REJECT" };
  if (expected === "UNKNOWN") return { change: "UNKNOWN", state: "UNKNOWN", action: "REJECT" };
  return { change: "UNSPECIFIED", state: "UNSPECIFIED", action: "UNKNOWN" };
}

function sourceSection(source, start, end) {
  const from = source.indexOf(start);
  if (from < 0) return "";
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  return source.slice(from, to < 0 ? source.length : to);
}

function lineNumber(source, needle) {
  const index = source.indexOf(needle);
  return index < 0 ? null : source.slice(0, index).split("\n").length;
}

async function staticAudit() {
  const loaded = {};
  for (const path of sourceFiles) loaded[relativePath(path)] = await readFile(path, "utf8");
  const cli = loaded[relativePath(sourceFiles[0])];
  const engine = loaded[relativePath(sourceFiles[1])];
  const evaluator = loaded[relativePath(sourceFiles[2])];
  const checks = [];
  const definition = sourceSection(cli, "function definitionFor", "function controlDefinition");
  const ablation = sourceSection(cli, "function executeAblation", "export async function runBenchmarkCli");
  const control = sourceSection(cli, "const controlResults", "const ablationResults");
  checks.push(check("expected-labels-consumed", definition.includes("expected") ? "pass" : "fail", definition.includes("expected") ? "definitionFor conserva las expectativas del escenario" : "definitionFor no incorpora scenario.expected; las etiquetas no pueden fallar la ejecución", { file: relativePath(sourceFiles[0]), line: lineNumber(cli, "function definitionFor") }));
  checks.push(check("repair-is-observed", /repaired:\s*!staleRecall/.test(engine) ? "fail" : "pass", /repaired:\s*!staleRecall/.test(engine) ? "repaired se deriva de no haber cambiado, no de una revalidación posterior" : "La reparación aparece como evento observable", { file: relativePath(sourceFiles[1]), line: lineNumber(engine, "repaired:") }));
  checks.push(check("reread-is-instrumented", /revalidationCalls:\s*0/.test(engine) ? "fail" : "pass", /revalidationCalls:\s*0/.test(engine) ? "runEpisode fija revalidationCalls en cero y no ejecuta read durante refresh" : "Las relecturas están instrumentadas", { file: relativePath(sourceFiles[1]), line: lineNumber(engine, "revalidationCalls:") }));
  checks.push(check("controls-derive-observations", /falseSuppression:\s*false/.test(control) ? "fail" : "pass", /falseSuppression:\s*false/.test(control) ? "Los controles reportan falseSuppression=false de forma literal" : "Los controles derivan falseSuppression de decisiones", { file: relativePath(sourceFiles[0]), line: lineNumber(cli, "falseSuppression: false") }));
  checks.push(check("ablations-are-behavioral", /capabilities\.delete/.test(ablation) && /observed === ablation\.expected/.test(ablation) ? "fail" : "pass", /capabilities\.delete/.test(ablation) && /observed === ablation\.expected/.test(ablation) ? "La ablation construye observed a partir de remove y después compara con expected; no ejecuta una variante" : "Las ablations ejecutan variantes independientes", { file: relativePath(sourceFiles[0]), line: lineNumber(cli, "function executeAblation") }));
  checks.push(check("latency-instrumentation", /latency|durationMs/i.test(`${cli}\n${engine}\n${evaluator}`) ? "pass" : "warn", /latency|durationMs/i.test(`${cli}\n${engine}\n${evaluator}`) ? "Existe algún campo de latencia" : "No hay duración por episodio ni percentiles", { file: relativePath(sourceFiles[1]) }));
  checks.push(check("memory-instrumentation", /memoryBytes|memoryTokens|tokenCount|serializedBytes|serializedMetadataBytes|memoryP50Bytes/i.test(`${cli}\n${engine}\n${evaluator}`) ? "pass" : "warn", /memoryBytes|memoryTokens|tokenCount|serializedBytes|serializedMetadataBytes|memoryP50Bytes/i.test(`${cli}\n${engine}\n${evaluator}`) ? "Existe algún contador de memoria" : "No hay bytes, tokens ni tamaño serializado", { file: relativePath(sourceFiles[1]) }));
  checks.push(check("history-fidelity", /historyPreserved:\s*steps\.some/.test(engine) ? "warn" : "pass", /historyPreserved:\s*steps\.some/.test(engine) ? "historyPreserved solo comprueba que existan dos nombres de paso" : "La historia se valida semánticamente", { file: relativePath(sourceFiles[1]), line: lineNumber(engine, "historyPreserved:") }));
  const reopenSection = sourceSection(engine, "if (definition.reopenBeforeRecall)", "const staleRecall");
  checks.push(check("episode-decisions-exported", /\bdecisions\s*:/.test(cli) ? "pass" : "warn", /\bdecisions\s*:/.test(cli) ? "El resultado exporta decisiones por episodio" : "Solo se exportan agregados; no se puede auditar cada decisión del baseline", { file: relativePath(sourceFiles[0]) }));
  checks.push(check("reopen-changes-observation", reopenSection.includes("world.read") ? "pass" : "warn", reopenSection.includes("world.read") ? "Reabrir cambia la observación" : "Reabrir solo añade un paso; no fuerza lectura ni invalida por sí mismo", { file: relativePath(sourceFiles[1]), line: lineNumber(engine, "reopenBeforeRecall") }));
  return { checks, sourceFiles: Object.keys(loaded) };
}

function strategyDecision(strategy, state, freshControl = false, ttlExpired = false) {
  if (freshControl) {
    if (strategy === "TTL Memory" && ttlExpired) return { decision: "RECHECK", revalidationCalls: 0, repaired: false };
    return { decision: "USE", revalidationCalls: 0, repaired: false };
  }
  if (strategy === "Plain Memory" || strategy === "TTL Memory") return { decision: "USE", revalidationCalls: 0, repaired: false };
  if (state === "REPAIRABLE") return { decision: "USE", revalidationCalls: 1, repaired: true };
  if (strategy === "Prompt Recheck" || strategy === "Always Refresh") return { decision: "REJECT", revalidationCalls: 1, repaired: false };
  return { decision: "REJECT", revalidationCalls: 0, repaired: false };
}

function scoreStrategy(strategy, episodes, controls) {
  const decisions = [
    ...episodes.map((episode) => ({ ...episode, ...strategyDecision(strategy, episode.oracle.state) })),
    ...controls.map((control) => ({ ...control, ...strategyDecision(strategy, "FRESH", true, control.ttlExpired) }))
  ];
  const dynamic = decisions.filter((entry) => entry.kind !== "control");
  const repairable = dynamic.filter((entry) => entry.oracle.state === "REPAIRABLE");
  const guarded = dynamic.filter((entry) => entry.oracle.state === "NON_REPAIRABLE" || entry.oracle.state === "UNKNOWN");
  const unsafe = dynamic.filter((entry) => entry.decision === "USE" && !entry.repaired).length;
  const rejectedGuarded = guarded.filter((entry) => entry.decision === "REJECT").length;
  const falseRejects = decisions.filter((entry) => entry.kind === "control" && entry.decision === "REJECT").length;
  const freshNonUse = decisions.filter((entry) => entry.kind === "control" && entry.decision !== "USE").length;
  const calls = dynamic.reduce((sum, entry) => sum + entry.revalidationCalls, 0);
  const history = episodes.filter((entry) => entry.trace?.historyPreserved === true).length / Math.max(1, episodes.length);
  return {
    baseline: strategy,
    denominators: { dynamic: dynamic.length, repairable: repairable.length, guarded: guarded.length, staticControls: controls.length },
    unsafeActionRate: unsafe / Math.max(1, dynamic.length),
    actionSafetyRate: 1 - unsafe / Math.max(1, dynamic.length),
    recoveryRate: repairable.length === 0 ? null : repairable.filter((entry) => entry.repaired && entry.decision === "USE").length / repairable.length,
    nonRepairableRejectRate: guarded.length === 0 ? null : rejectedGuarded / guarded.length,
    falseRejectRate: falseRejects / Math.max(1, controls.length),
    freshNonUseRate: freshNonUse / Math.max(1, controls.length),
    revalidationCalls: calls,
    revalidationCallsPerEpisode: calls / Math.max(1, dynamic.length),
    historyPreservationRate: history,
    latencyP50Ms: null,
    latencyP95Ms: null,
    memoryP50Bytes: null,
    memoryP95Bytes: null,
    decisionTrace: decisions.map((entry) => ({ episodeId: entry.episodeId ?? entry.id, kind: entry.kind, state: entry.oracle?.state ?? "FRESH", decision: entry.decision, repaired: entry.repaired, revalidationCalls: entry.revalidationCalls }))
  };
}

function pairedAudit(raw, scenarios, controls) {
  const traces = Array.isArray(raw?.traces) ? raw.traces : [];
  const traceById = new Map(traces.map((trace) => [trace.episodeId, trace]));
  const episodes = scenarios.map((scenario) => ({
    episodeId: scenario.id,
    kind: scenario.kind,
    oracle: scenarioExpectation(scenario),
    trace: traceById.get(scenario.id) ?? null,
    observedChange: traceById.get(scenario.id)?.changeStatus ?? "MISSING",
    repairableObserved: traceById.get(scenario.id)?.repairPossible ?? null
  }));
  const controlEpisodes = controls.map((control) => ({ id: control.id, kind: "control", ttlExpired: control.recall.includes("expiry"), oracle: { state: "FRESH" }, trace: null }));
  const strategies = ["Plain Memory", "Prompt Recheck", "TTL Memory", "Always Refresh", "PREMiSE Explicit"];
  return {
    source: "scenario labels + exported traces; reference decision model, not a claim of implementation telemetry",
    episodes,
    scores: strategies.map((strategy) => scoreStrategy(strategy, episodes, controlEpisodes))
  };
}

function auditScenarios(raw, scenarios, controls, ablations, staticChecks) {
  const traces = Array.isArray(raw?.traces) ? raw.traces : [];
  const traceById = new Map(traces.map((trace) => [trace.episodeId, trace]));
  const mismatches = [];
  const missingRepairEvidence = [];
  const repairabilityMismatches = [];
  for (const scenario of scenarios) {
    const trace = traceById.get(scenario.id);
    const oracle = scenarioExpectation(scenario);
    if (!trace) {
      mismatches.push({ episodeId: scenario.id, expected: oracle.change, observed: "MISSING" });
      continue;
    }
    if (oracle.change !== "UNSPECIFIED" && trace.changeStatus !== oracle.change) mismatches.push({ episodeId: scenario.id, expected: oracle.change, observed: trace.changeStatus });
    if (oracle.state === "REPAIRABLE" && trace.repairPossible !== true) repairabilityMismatches.push({ episodeId: scenario.id, expected: true, observed: trace.repairPossible });
    if (oracle.state !== "REPAIRABLE" && trace.repairPossible === true) repairabilityMismatches.push({ episodeId: scenario.id, expected: false, observed: trace.repairPossible });
    if (scenario.expected?.afterRepair === "FRESH" && trace.repaired !== true && !trace.steps?.some((step) => /repair|revalidat/i.test(step.name))) missingRepairEvidence.push(scenario.id);
  }
  const scenarioIds = scenarios.map((scenario) => scenario.id);
  const traceIds = traces.map((trace) => trace.episodeId);
  const duplicateTraceIds = traceIds.filter((id, index) => traceIds.indexOf(id) !== index);
  const nonRepairable = scenarios.filter((scenario) => ["NON_REPAIRABLE", "UNKNOWN"].includes(scenarioExpectation(scenario).state));
  const repairable = scenarios.filter((scenario) => scenarioExpectation(scenario).state === "REPAIRABLE");
  const expectedAfterRepair = scenarios.filter((scenario) => scenario.expected?.afterRepair === "FRESH");
  const reportedResults = Array.isArray(raw?.results) ? raw.results : [];
  const decisionCoverage = reportedResults.length > 0 && reportedResults.every((result) => Array.isArray(result.decisionTrace) && result.decisionTrace.length === scenarios.length);
  const measuredCost = reportedResults.length > 0 && reportedResults.every((result) => Number.isFinite(result.latencyP50Ms) && Number.isFinite(result.latencyP95Ms) && Number.isFinite(result.memoryP50Bytes) && Number.isFinite(result.memoryP95Bytes));
  const staticAllPassed = Array.isArray(raw?.controls) && raw.controls.length === controls.length && raw.controls.every((control) => control.passed === true);
  const ablationsAllPassed = Array.isArray(raw?.ablations) && raw.ablations.length === ablations.length && raw.ablations.every((ablation) => ablation.passed === true);
  const checks = [
    check("format-and-counts", raw?.format === "premise-benchmark-results/0.1" && raw?.suite === "v0.1" && raw?.scenarioCount === scenarios.length && raw?.traceCount === scenarios.length ? "pass" : "fail", "Formato y cardinalidades declaradas", { format: raw?.format, suite: raw?.suite, scenarioCount: raw?.scenarioCount, traceCount: raw?.traceCount, expectedScenarios: scenarios.length }),
    check("paired-episode-coverage", scenarioIds.length === traceIds.length && scenarioIds.every((id) => traceById.has(id)) && duplicateTraceIds.length === 0 ? "pass" : "fail", "Cada episodio del catálogo tiene exactamente una traza", { scenarios: scenarioIds.length, traces: traceIds.length, duplicateTraceIds }),
    check("oracle-label-agreement", mismatches.length === 0 ? "pass" : "fail", mismatches.length === 0 ? "Las etiquetas expected coinciden con changeStatus" : `${mismatches.length}/${scenarios.length} etiquetas expected no coinciden con changeStatus`, { mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 25) }),
    check("repairability-agreement", repairabilityMismatches.length === 0 ? "pass" : "fail", repairabilityMismatches.length === 0 ? "repairPossible coincide con el oráculo conservador" : `${repairabilityMismatches.length} episodios tienen repairability incompatible con sus etiquetas`, { repairableEpisodes: repairable.length, nonRepairableOrUnknownEpisodes: nonRepairable.length, mismatches: repairabilityMismatches.slice(0, 25) }),
    check("repair-transition-evidence", expectedAfterRepair.length > 0 && missingRepairEvidence.length > 0 ? "fail" : "pass", expectedAfterRepair.length > 0 && missingRepairEvidence.length > 0 ? `${missingRepairEvidence.length}/${expectedAfterRepair.length} episodios prometen afterRepair=FRESH pero no exportan una transición de reparación` : "Las reparaciones prometidas tienen evidencia", { expectedAfterRepair: expectedAfterRepair.length, missingRepairEvidence }),
    check("non-repairable-cases", nonRepairable.length > 0 ? "pass" : "fail", nonRepairable.length > 0 ? `Hay ${nonRepairable.length} episodios que deben rechazar o permanecer desconocidos` : "No existen casos no reparables; el benchmark puede premiar recuperación infinita", { ids: nonRepairable.map((scenario) => scenario.id) }),
    check("static-controls", staticAllPassed ? "pass" : "fail", staticAllPassed ? `${controls.length} controles estáticos reportan passed=true` : "Los controles estáticos faltan o fallan", { expected: controls.length, observed: raw?.controls?.length ?? 0 }),
    check("ablation-execution", ablationsAllPassed && staticChecks.checks.find((entry) => entry.id === "ablations-are-behavioral")?.status === "fail" ? "fail" : "pass", ablationsAllPassed ? "Las ablations tienen resultado, pero deben ser variantes ejecutadas" : "Las ablations no pasan", { reportedPassed: ablationsAllPassed, count: raw?.ablations?.length ?? 0 }),
    check("baseline-paired-decisions", decisionCoverage ? "pass" : "warn", decisionCoverage ? "Cada estrategia exporta una decisión auditable por episodio" : "Los agregados todavía no exportan decisiones completas por episodio", { baselines: reportedResults.map((result) => ({ baseline: result.baseline, episodes: result.episodes, decisions: Array.isArray(result.decisionTrace) ? result.decisionTrace.length : 0 })) }),
    check("latency-and-memory", measuredCost ? "pass" : "warn", measuredCost ? "Latencia y metadata serializada están instrumentadas" : "Latencia y memoria son dimensiones obligatorias y aún faltan medidas completas", { latency: reportedResults.map((result) => ({ baseline: result.baseline, p50: result.latencyP50Ms, p95: result.latencyP95Ms })), memory: reportedResults.map((result) => ({ baseline: result.baseline, p50: result.memoryP50Bytes, p95: result.memoryP95Bytes })) }),
    check("history-evidence", staticChecks.checks.find((entry) => entry.id === "history-fidelity")?.status === "pass" ? "pass" : "warn", "historyPreservationRate existe, pero su evidencia semántica es débil", { reportedHistoryRate: reportedResults.map((result) => ({ baseline: result.baseline, value: result.historyPreservationRate })) })
  ];
  return { checks, mismatches, repairabilityMismatches, missingRepairEvidence, denominators: { scenarios: scenarios.length, traces: traces.length, repairable: repairable.length, nonRepairableOrUnknown: nonRepairable.length, expectedAfterRepair: expectedAfterRepair.length }, reportedResults };
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function regressionGate(currentScores, previousPayload) {
  if (!previousPayload) return { status: "not_run", reason: "Pasa --compare-to <evaluation.json> para ejecutar el gate contra una ejecución anterior.", thresholds };
  const previousScores = previousPayload.pairedEpisodeAudit?.scores ?? previousPayload.pairedScores ?? [];
  const previousByBaseline = new Map(previousScores.map((score) => [score.baseline, score]));
  const rows = [];
  for (const current of currentScores) {
    const previous = previousByBaseline.get(current.baseline);
    if (!previous) {
      rows.push({ baseline: current.baseline, status: "uncomparable", reason: "No existe el baseline en la ejecución anterior." });
      continue;
    }
    const checks = [
      ["unsafeActionRate", current.unsafeActionRate - previous.unsafeActionRate <= thresholds.safety.maxIncreasePp, current.unsafeActionRate - previous.unsafeActionRate, thresholds.safety.maxIncreasePp],
      ["recoveryRate", previous.recoveryRate === null || current.recoveryRate === null || previous.recoveryRate - current.recoveryRate <= thresholds.recovery.maxDropPp, previous.recoveryRate === null || current.recoveryRate === null ? null : previous.recoveryRate - current.recoveryRate, thresholds.recovery.maxDropPp],
      ["falseRejectRate", current.falseRejectRate - previous.falseRejectRate <= thresholds.falseRejects.maxIncreasePp, current.falseRejectRate - previous.falseRejectRate, thresholds.falseRejects.maxIncreasePp],
      ["revalidationCallsPerEpisode", current.revalidationCallsPerEpisode - previous.revalidationCallsPerEpisode <= Math.max(thresholds.rereadCost.maxExtraCallsPerEpisode, previous.revalidationCallsPerEpisode * thresholds.rereadCost.maxIncreasePct), current.revalidationCallsPerEpisode - previous.revalidationCallsPerEpisode, Math.max(thresholds.rereadCost.maxExtraCallsPerEpisode, previous.revalidationCallsPerEpisode * thresholds.rereadCost.maxIncreasePct)],
      ["historyPreservationRate", previous.historyPreservationRate - current.historyPreservationRate <= thresholds.history.maxDropPp, previous.historyPreservationRate - current.historyPreservationRate, thresholds.history.maxDropPp]
    ];
    const failed = checks.filter(([, passed]) => !passed);
    rows.push({ baseline: current.baseline, status: failed.length === 0 ? "pass" : "fail", checks: checks.map(([metric, passed, delta, limit]) => ({ metric, passed, delta, limit })) });
  }
  return { status: rows.some((row) => row.status === "fail") ? "fail" : "pass", thresholds, rows };
}

function formatPercent(value) {
  return value === null || value === undefined ? "no medido" : `${(value * 100).toFixed(1)}%`;
}

function buildMarkdown(report) {
  const v01 = report.v01;
  const audit = report.validity;
  const scores = report.pairedEpisodeAudit?.scores ?? [];
  const lines = [
    "# Auditoría de evaluación PREMiSE",
    "",
    `Generado: ${report.generatedAt}`,
    "",
    "## Conclusión",
    "",
    `- Estado de validez de v0.1: **${report.overallValidity.toUpperCase()}**.`,
    `- Ejecución actual: ${v01.available ? "disponible" : "no disponible"}; ` + (v01.available ? `${v01.result.scenarioCount} escenarios, ${v01.result.traceCount} trazas, ${v01.result.controlCount} controles y ${v01.result.ablationCount} ablations.` : (v01.error ?? "sin detalle")),
    `- Comparativas externas: ${report.externalSources.map((source) => `${source.name}=${source.status}`).join(", ")}.`,
    "- La evaluación no convierte una métrica aislada en una victoria universal: primero exige seguridad, luego recuperación y finalmente coste.",
    "- La campaña paired ya exporta decisiones por episodio y compara PREMiSE con un baseline sin protocolo y con perfiles de contexto largo.",
    "- `real-world-bench` y `context-corpus-bench` se reportan por separado: sus métricas no se agregan a los denominadores de v0.1 ni entre sí.",
    "",
    "## Comandos reproducibles",
    "",
    "```text",
    "node benchmarks/premise-memory-bench/test/benchmark.test.mjs",
    "pnpm benchmark:real-world",
    "pnpm benchmark:context-corpus",
    "node benchmarks/evaluation/runner.mjs",
    "node benchmarks/evaluation/runner.mjs --compare-to benchmarks/evaluation/evaluation.json",
    "```",
    "",
    "Los artefactos se escriben en benchmarks/evaluation/: v01-current.json, evaluation.json y evaluation.md.",
    "",
    "## Qué significa «mejor»",
    "",
    "La unidad de análisis es el episodio emparejado por `episodeId`; cada estrategia recibe el mismo episodio y el mismo oráculo. La evaluación no colapsa las dimensiones en una sola victoria:",
    "",
    "| Dimensión | Métrica | Dirección | Gate inicial |",
    "| --- | --- | --- | --- |",
    "| Seguridad de acciones | `unsafeActionRate`, `actionSafetyRate` | menor / mayor | 0% de uso inseguro |",
    "| Recuperación posible | `recoveryRate` | mayor | ≥95% cuando n≥10 |",
    "| No reparable/desconocido | `nonRepairableRejectRate` | mayor | 100% de rechazo seguro |",
    "| Coste de relectura | llamadas por episodio y por éxito | menor | +10% o +0.10 llamadas |",
    "| Latencia | p50/p95 por episodio | menor | +20% y +50 ms |",
    "| Memoria | p50/p95 bytes o tokens | menor | +15% y +4 KiB |",
    "| Historial | preservación semántica | mayor | no caer >2 pp |",
    "| Falsos rechazos | rechazo en controles frescos | menor | +2 pp; controles 100% |",
    "",
    "Latencia y memoria quedan como `null` cuando no hay instrumentación. Un `REJECT` seguro en un caso no reparable no se cuenta como éxito de tarea: seguridad y utilidad se reportan por separado.",
    "",
    "## Resultados v0.1 disponibles",
    "",
    "| Baseline | stale recall | stale action | repair agregado | task success | relecturas | historial |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(v01.available ? v01.result.results.map((result) => `| ${result.baseline} | ${formatPercent(result.staleRecallRate)} | ${formatPercent(result.staleActionRate)} | ${formatPercent(result.dynamicMemoryRepairRate)} | ${formatPercent(result.taskSuccessRate)} | ${result.revalidationCalls} | ${formatPercent(result.historyPreservationRate)} |`) : ["| — | no disponible | — | — | — | — | — |"]),
    "",
    "Estos son los números que el benchmark histórico imprime junto con su `decisionTrace`; la comparación más directa y estricta está en `benchmarks/comparative-bench/results.json`.",
    "",
    "## Auditoría de validez",
    "",
    "| Check | Estado | Evidencia |",
    "| --- | --- | --- |",
    ...[...(report.staticAudit.checks ?? []), ...(audit.checks ?? [])].map((entry) => `| ${entry.id} | ${entry.status} | ${entry.summary.replaceAll("|", "\\|")} |`),
    "",
    `Denominadores del oráculo: ${audit.denominators.repairable} reparables, ${audit.denominators.nonRepairableOrUnknown} no reparables/desconocidos, ${audit.denominators.expectedAfterRepair} con reparación explícita esperada, de ${audit.denominators.scenarios} episodios.`,
    "",
    "Caveats que permanecen explícitos:",
    "",
    "- La memoria medida en v0.1 es metadata serializada; el benchmark de contexto largo añade también un muestreo de heap de proceso.",
    "- Los perfiles largos son mediciones locales de Node 24 y deben repetirse en el hardware objetivo antes de usarse como SLA.",
    "- Los escenarios GitHub-like siguen siendo mundos deterministas locales; no sustituyen un adapter real conectado a GitHub.",
    "- `real-world-bench` y `context-corpus-bench` son fuentes opcionales; si están presentes, el auditor conserva sus métricas y denominadores por fila sin combinarlos.",
    "",
    "## Comparación paired por episodio (oráculo conservador)",
    "",
    "Esta tabla conserva el oráculo conservador para comparar estrategias con el mismo denominador. Las trazas ejecutables y los benchmarks de escala están en los artefactos externos enlazados abajo.",
    "",
    "| Baseline | seguridad | recuperación | rechazo no reparable | falsos rechazos | relecturas/episodio | historial |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...scores.map((score) => `| ${score.baseline} | ${formatPercent(score.actionSafetyRate)} | ${formatPercent(score.recoveryRate)} | ${formatPercent(score.nonRepairableRejectRate)} | ${formatPercent(score.falseRejectRate)} | ${score.revalidationCallsPerEpisode.toFixed(2)} | ${formatPercent(score.historyPreservationRate)} |`),
    "",
    "La decisión de producto debe aplicar primero el gate de seguridad y después optimizar recuperación/coste. No se debe rankear una estrategia que usa memoria inválida aunque tenga menor latencia.",
    "",
    "## Fuentes externas",
    "",
    ...report.externalSources.flatMap((source) => {
      const detail = source.status === "absent" ? source.limitation : `${source.files.length} ficheros, ${source.recognizedRows.length} filas métricas reconocidas`;
      const metricNames = source.recognizedMetricNames ?? [...new Set(source.recognizedRows.flatMap((row) => Object.keys(row.metrics ?? {})))];
      const denominatorNames = [...new Set((source.denominatorScopes ?? []).flatMap((scope) => Object.keys(scope.denominators ?? {})))];
      return [
        `- **${source.name}**: ${source.status}; ${detail}`,
        `  - Métricas reconocidas: ${metricNames.length > 0 ? metricNames.map((name) => `\`${name}\``).join(", ") : "ninguna"}.`,
        `  - Denominadores observados por fila (sin combinar): ${denominatorNames.length > 0 ? denominatorNames.map((name) => `\`${name}\``).join(", ") : "no declarados"}.`
      ];
    }),
    "",
    "El runner descubre `comparative-bench`, `long-context-bench`, `real-world-bench` y `context-corpus-bench`, guarda hashes, parsea filas métricas reconocibles y conserva los casos no reconocidos como limitación. No mezcla denominadores automáticamente.",
    "",
    "## Umbrales de regresión",
    "",
    "Los umbrales están en `evaluation.json` y se aplican al pasar `--compare-to`:",
    "",
    "- seguridad: no aumentar `unsafeActionRate` más de 0.5 pp y nunca introducir uso inseguro en un caso protegido;",
    "- recuperación: no caer más de 5 pp;",
    "- falsos rechazos: no aumentar más de 2 pp y mantener controles estáticos al 100%;",
    "- relecturas: no aumentar más de 10% ni 0.10 llamadas por episodio;",
    "- latencia/memoria: no aumentar más de 20%/15% ni 50 ms/4 KiB;",
    "- historial: no caer más de 2 pp.",
    "",
    `Gate de esta ejecución: **${report.regressionGate.status}** (${report.regressionGate.reason ?? "comparación ejecutada"}).`,
    "",
    "## Prioridad de siguientes experimentos",
    "",
    "1. **P0 — Repetir en hardware objetivo**: capturar latencia, heap y coste de revalidación con el mismo Node 24 y límites de despliegue.",
    "2. **P0 — Contextos de payload real**: añadir tamaños de contenido externo y medir retrieval/adaptador sin contaminar el sidecar de metadata.",
    "3. **P1 — Validators reales**: conectar filesystem/Git/GitHub cuando exista el adapter, manteniendo los mundos deterministas como control.",
    "4. **P1 — Grafos dinámicos**: medir updates parciales, subgrafos solapados, reemplazos e invalidación concurrente.",
    "5. **P2 — Gate de regresión**: guardar una ejecución aceptada y ejecutar `--compare-to` en CI para bloquear pérdidas de seguridad o escalabilidad.",
    ""
  ];
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

async function main() {
  await mkdir(evaluationDir, { recursive: true });
  const capturedAt = new Date().toISOString();
  const [capture, staticAuditResult, ...externalSources] = await Promise.all([
    hasArg("--no-run-v01") && argValue("--v01-input") === undefined ? { available: false, source: "disabled", command: null, error: "Ejecución v0.1 desactivada por --no-run-v01." } : captureV01(),
    staticAudit(),
    ...externalBenchmarkNames.map((name) => externalSource(name))
  ]);
  const catalogs = [];
  for (const [kind, path] of scenarioRoots) {
    const raw = await readJson(path);
    catalogs.push(...raw.scenarios.map((scenario) => ({ ...scenario, kind })));
  }
  const controls = (await readJson(controlFile)).controls;
  const ablations = (await readJson(ablationFile)).ablations;
  if (capture.available) await writeJson(join(evaluationDir, "v01-current.json"), capture.result);
  const raw = capture.result ?? {};
  const validity = auditScenarios(raw, catalogs, controls, ablations, staticAuditResult);
  const paired = capture.available ? pairedAudit(raw, catalogs, controls) : { source: "unavailable", episodes: [], scores: [] };
  const previousPath = argValue("--compare-to");
  let previous = null;
  if (previousPath) {
    try { previous = await readJson(resolve(root, previousPath)); } catch (error) { previous = { error: error.message }; }
  }
  const regressionGate = previous?.error ? { status: "error", reason: previous.error, thresholds } : regressionGateFor(paired.scores, previous);
  const report = {
    format: "premise-benchmark-evaluation/0.1",
    generatedAt: capturedAt,
    command: "node benchmarks/evaluation/runner.mjs",
    root: relativePath(root),
    overallValidity: !capture.available ? "unavailable" : [...staticAuditResult.checks, ...validity.checks].some((entry) => entry.status === "fail") ? "invalid" : "provisionally-valid",
    methodology: {
      unit: "episode paired by episodeId",
      oracle: "scenario expected labels, conservatively treating INVALID/UNKNOWN without afterRepair as guarded",
      safetyFirst: true,
      nonRepairableCasesRequired: true,
      staticControlsRequired: true,
      measuredDimensions: ["action safety", "recovery", "reread cost", "latency", "memory", "history", "false rejects"],
      unmeasuredValuesAreNull: true
    },
    thresholds,
    v01: { available: capture.available, source: capture.source, command: capture.command, error: capture.error, result: capture.available ? { format: raw.format, suite: raw.suite, runner: raw.runner, scenarioCount: raw.scenarioCount, traceCount: raw.traceCount, controlCount: raw.controlCount, ablationCount: raw.ablationCount, results: raw.results, controls: raw.controls, ablations: raw.ablations } : null },
    staticAudit: staticAuditResult,
    validity,
    pairedEpisodeAudit: paired,
    externalSources,
    regressionGate
  };
  await writeJson(join(evaluationDir, "evaluation.json"), report);
  await writeFile(join(evaluationDir, "evaluation.md"), buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    overallValidity: report.overallValidity,
    v01: report.v01.available ? "available" : "unavailable",
    staticFailures: report.staticAudit.checks.filter((entry) => entry.status === "fail").length,
    validityFailures: report.validity.checks.filter((entry) => entry.status === "fail").length,
    externalSources: report.externalSources.map((source) => `${source.name}:${source.status}`),
    outputs: ["benchmarks/evaluation/v01-current.json", "benchmarks/evaluation/evaluation.json", "benchmarks/evaluation/evaluation.md"]
  }, null, 2));
}

function regressionGateFor(currentScores, previous) {
  return regressionGate(currentScores, previous);
}

await main();
