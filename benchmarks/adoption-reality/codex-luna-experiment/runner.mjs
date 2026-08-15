import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = join(root, ".tmp", "adoption", "codex-luna-experiment");
const inputRoot = join(runRoot, "input");
const candidateRoot = join(runRoot, "candidate");
const reportPath = join(runRoot, "report.json");
const publicSkill = join(root, ".agents", "skills", "premise");
const pluginRoot = join(root, "plugins", "premise-codex");
const sdkRoot = join(root, "packages", "sdk");
const sdkGateRoot = join(root, ".tmp", "adoption", "package-gate");
const sourceExtensions = new Set([".cjs", ".js", ".mjs", ".jsx", ".ts", ".tsx"]);
const forbiddenContent = /\b(?:oracle|ground\s*truth|answer\s*key|private\s*runtime|workspace:|packages\/runtime-core)\b/iu;
const credentialLiteral = /\b(?:Bearer\s+[A-Za-z0-9._~-]{12,}|(?:sk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{10,})\b/iu;
const importPatterns = [
  /\bimport\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/gu,
  /\bexport\s+[\s\S]*?\sfrom\s+["']([^"']+)["']/gu,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu
];

function args() {
  const values = process.argv.slice(2);
  return {
    contractOnly: values.includes("--contract-only"),
    prepareOnly: values.includes("--prepare-only"),
    evaluateOnly: values.includes("--evaluate-only"),
    securitySelfCheck: values.includes("--security-self-check"),
    candidateSmokeSelfCheck: values.includes("--candidate-smoke-self-check"),
    run: values.includes("--run")
  };
}

async function filesUnder(directory, current = directory, ignoredDirectories = new Set()) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await filesUnder(directory, absolute, ignoredDirectories));
    }
    else files.push(relative(directory, absolute).split(sep).join("/"));
  }
  return files.sort();
}

function run(command, commandArgs, cwd, environment = process.env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, {
      cwd,
      // An explicit environment is authoritative. Do not merge process.env
      // here: the isolated agent environment has already been scrubbed.
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

async function findSdkTarball() {
  const files = await readdir(sdkGateRoot, { withFileTypes: true }).catch(() => []);
  const tarball = files.find((entry) => entry.isFile() && entry.name.endsWith(".tgz"));
  return tarball === undefined ? undefined : join(sdkGateRoot, tarball.name);
}

async function prepareInput({ includeTarball }) {
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(inputRoot, { recursive: true });
  await mkdir(candidateRoot, { recursive: true });

  await cp(publicSkill, join(inputRoot, "public-skill"), { recursive: true });
  await mkdir(join(inputRoot, "public-sdk"), { recursive: true });
  await cp(join(sdkRoot, "package.json"), join(inputRoot, "public-sdk", "package.json"));
  await cp(join(sdkRoot, "README.md"), join(inputRoot, "public-sdk", "README.md"));
  await mkdir(join(inputRoot, "public-plugin"), { recursive: true });
  await cp(join(pluginRoot, "README.md"), join(inputRoot, "public-plugin", "README.md"));
  await cp(join(pluginRoot, ".mcp.json"), join(inputRoot, "public-plugin", ".mcp.json"));
  const tarball = includeTarball ? await findSdkTarball() : undefined;
  if (includeTarball && tarball !== undefined) {
    await cp(tarball, join(inputRoot, "public-sdk", "premise-sdk.tgz"));
  }
  const allowedFiles = [
    ...(await filesUnder(inputRoot)).filter((file) => !file.endsWith(".tgz") || includeTarball),
    "TASK.md",
    "manifest.json"
  ].sort();
  const manifest = {
    format: "premise-isolated-codex-input/1",
    publicOnly: true,
    network: false,
    credentials: false,
    allowedFiles,
    packageArtifact: tarball === undefined ? "NOT_AVAILABLE" : "public-sdk/premise-sdk.tgz"
  };
  await writeFile(join(inputRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const task = [
    "# Isolated PREMiSE integration task",
    "",
    "You are an isolated Codex/Luna integration worker. Work only inside this",
    "experiment directory. Read only input/TASK.md, input/manifest.json, the",
    "files below input/public-skill/, input/public-sdk/, and input/public-plugin/.",
    "Do not inspect a parent directory or repository, use private packages, use",
    "benchmark data, use credentials, call the network, or use an oracle.",
    "",
    "Create a minimal external Node.js 24 consumer in candidate/ using only the",
    "public @premise/sdk package. Read the public Skill and package/docs first.",
    "Export a small createClient({ baseUrl, tenantId, token }) factory without",
    "making a request during import. Use the local package artifact if present.",
    "Write candidate/run.json with format premise-isolated-codex-run/1, the exact",
    "candidate files, public input reads, credentialsUsed: false, a success",
    "event, and no private paths."
  ].join("\n");
  await writeFile(join(inputRoot, "TASK.md"), task + "\n", "utf8");
  return { allowedFiles, packageArtifact: manifest.packageArtifact };
}

function candidateImports(source) {
  const values = new Set();
  for (const pattern of importPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) values.add(match[1]);
  }
  return [...values].sort();
}

async function evaluateCandidate() {
  const files = (await filesUnder(candidateRoot, candidateRoot, new Set(["node_modules"]))).filter((file) => file !== "package-lock.json");
  const changedFiles = files.filter((file) => file !== "run.json");
  const errors = [];
  if (!changedFiles.includes("agent.mjs")) errors.push("candidate must include agent.mjs");
  if (!changedFiles.includes("package.json")) errors.push("candidate must include package.json");
  const sourceFiles = files.filter((file) => sourceExtensions.has(file.slice(file.lastIndexOf("."))));
  let hasPublicImport = false;
  let hasClientUse = false;
  const internalImports = [];
  for (const file of sourceFiles) {
    const content = await readFile(join(candidateRoot, ...file.split("/")), "utf8");
    if (forbiddenContent.test(content)) errors.push(`${file} contains private/evaluator wording`);
    if (credentialLiteral.test(content)) errors.push(`${file} contains a credential literal`);
    for (const specifier of candidateImports(content)) {
      if (specifier === "@premise/sdk") hasPublicImport = true;
      if (specifier.startsWith("@premise/") && specifier !== "@premise/sdk") internalImports.push(`${file} -> ${specifier}`);
      if (specifier.startsWith("../") || specifier.startsWith("../../") || specifier.startsWith("file:")) internalImports.push(`${file} -> ${specifier}`);
    }
    if (/\bPremiseClient\b/u.test(content)) hasClientUse = true;
  }
  if (!hasPublicImport) errors.push("candidate does not import @premise/sdk");
  if (!hasClientUse) errors.push("candidate does not use PremiseClient");
  if (internalImports.length > 0) errors.push(...internalImports.map((value) => `internal import: ${value}`));
  try {
    const packageJson = JSON.parse(await readFile(join(candidateRoot, "package.json"), "utf8"));
    const dependencies = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
    const dependencyNames = Object.keys(dependencies);
    if (dependencyNames.length !== 1 || dependencyNames[0] !== "@premise/sdk") errors.push("candidate package must depend only on @premise/sdk");
    if (typeof dependencies["@premise/sdk"] !== "string" || !dependencies["@premise/sdk"].startsWith("file:")) errors.push("candidate must use the supplied local public package artifact");
  } catch (error) {
    errors.push(`candidate package.json is invalid: ${error.message}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(inputRoot, "manifest.json"), "utf8"));
  } catch (error) {
    errors.push(`input manifest is invalid: ${error.message}`);
    manifest = { allowedFiles: [] };
  }
  let trace;
  try {
    trace = JSON.parse(await readFile(join(candidateRoot, "run.json"), "utf8"));
  } catch (error) {
    errors.push(`candidate run.json is invalid: ${error.message}`);
    trace = {};
  }
  if (trace.format !== "premise-isolated-codex-run/1") errors.push("candidate run format is invalid");
  if (trace.agentLaunched !== true) errors.push("candidate does not report a real agent launch");
  if (trace.credentialsUsed !== false) errors.push("candidate does not report credentialsUsed=false");
  if (trace.success !== true) errors.push("candidate run does not report success");
  if (!Array.isArray(trace.filesChanged) || JSON.stringify([...trace.filesChanged].sort()) !== JSON.stringify([...changedFiles].sort())) errors.push("run filesChanged does not match the candidate");
  const reads = Array.isArray(trace.publicReads) ? trace.publicReads : [];
  if (reads.length === 0 || reads.some((file) => !manifest.allowedFiles.includes(file))) errors.push("run publicReads leaves the public input boundary");
  if (!Array.isArray(trace.events) || !trace.events.some((event) => event?.type === "success")) errors.push("run has no success event");
  return { status: errors.length === 0 ? "PASS" : "FAIL", success: errors.length === 0, filesChanged: changedFiles, internalImports, publicReads: reads, errors, agentLaunched: trace.agentLaunched === true, credentialsUsed: trace.credentialsUsed === true };
}

function commandFromEnvironment() {
  const raw = process.env.PREMISE_LUNA_COMMAND ?? process.env.PREMISE_CODEX_COMMAND;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((value) => typeof value !== "string")) throw new Error("PREMISE_*_COMMAND must be a JSON array of strings");
  return parsed;
}

function scrubbedAgentEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/iu.test(key))
  );
  delete environment.PREMISE_LUNA_COMMAND;
  delete environment.PREMISE_CODEX_COMMAND;
  return {
    ...environment,
    PREMISE_EXPERIMENT_ROOT: runRoot,
    PREMISE_EXPERIMENT_INPUT: inputRoot,
    PREMISE_EXPERIMENT_NETWORK: "disabled",
    PREMISE_EXPERIMENT_CREDENTIALS: "disabled"
  };
}

function runCandidateSmoke() {
  return run(process.execPath, [
    "--input-type=module",
    "-e",
    "const m = await import('./agent.mjs'); const c = m.createClient({ baseUrl: 'http://example.invalid/', tenantId: 'tenant:experiment' }); if (!c || c.constructor.name !== 'PremiseClient') process.exit(1);"
  ], candidateRoot, scrubbedAgentEnvironment());
}

async function launchAgent() {
  const command = commandFromEnvironment();
  if (command === undefined) return { status: "NOT_RUN", success: false, agentLaunched: false, reason: "set PREMISE_LUNA_COMMAND or PREMISE_CODEX_COMMAND to launch an external runner" };
  const executable = process.platform === "win32" && (command[0] === "node" || command[0] === "node.exe") ? process.execPath : command[0];
  const prompt = `Read ${join(inputRoot, "TASK.md")} and execute the isolated task. The experiment root is ${runRoot}. Do not read outside it.`;
  const commandArgs = command.slice(1);
  const placeholder = commandArgs.indexOf("{prompt}");
  if (placeholder >= 0) commandArgs[placeholder] = prompt;
  else commandArgs.push(prompt);
  const result = await run(executable, commandArgs, runRoot, scrubbedAgentEnvironment());
  let evaluation = result.code === 0
    ? { ...(await evaluateCandidate()), agentLaunched: true, credentialsUsed: false }
    : { status: "FAIL", success: false, errors: [`agent exited with code ${result.code}`], agentLaunched: true, credentialsUsed: false };
  if (result.code === 0 && evaluation.success) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const install = await run(npm, ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], candidateRoot, scrubbedAgentEnvironment());
    if (install.code !== 0) {
      evaluation = { ...evaluation, status: "FAIL", success: false, errors: [...evaluation.errors, `offline package install failed: ${install.stderr.slice(-1_000)}`] };
    } else {
      const smoke = await runCandidateSmoke();
      if (smoke.code !== 0) evaluation = { ...evaluation, status: "FAIL", success: false, errors: [...evaluation.errors, `candidate smoke failed: ${smoke.stderr.slice(-1_000)}`] };
    }
  }
  return { ...evaluation, command: [executable, ...commandArgs.slice(0, -1)], exitCode: result.code, stderr: result.stderr.slice(-2_000), stdout: result.stdout.slice(-2_000) };
}

const options = args();
if (options.candidateSmokeSelfCheck) {
  const sentinel = process.env.PREMISE_SENTINEL_SECRET ?? "premise-candidate-smoke-sentinel-91c2d7";
  process.env.PREMISE_SENTINEL_SECRET = sentinel;
  await rm(candidateRoot, { recursive: true, force: true });
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(join(candidateRoot, "agent.mjs"), [
    "if (process.env.PREMISE_SENTINEL_SECRET !== undefined) process.exit(73);",
    "class PremiseClient {}",
    "export function createClient() { return new PremiseClient(); }"
  ].join("\n") + "\n", "utf8");
  const result = await runCandidateSmoke();
  const report = {
    format: "premise-isolated-codex-candidate-smoke-self-check/1",
    status: result.code === 0 ? "PASS" : "FAIL",
    success: result.code === 0,
    credentialExposed: result.code === 73,
    exitCode: result.code
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.success) process.exitCode = 1;
} else if (options.securitySelfCheck) {
  const sentinel = process.env.PREMISE_SENTINEL_SECRET ?? "premise-sentinel-do-not-forward-7f44e8";
  process.env.PREMISE_SENTINEL_SECRET = sentinel;
  await mkdir(runRoot, { recursive: true });
  const result = await run(process.execPath, ["-e", "process.exit(process.env.PREMISE_SENTINEL_SECRET === undefined ? 0 : 73)"], runRoot, scrubbedAgentEnvironment());
  const report = {
    format: "premise-isolated-codex-credential-self-check/1",
    status: result.code === 0 ? "PASS" : "FAIL",
    success: result.code === 0,
    credentialExposed: result.code === 73,
    exitCode: result.code
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.success) process.exitCode = 1;
} else {
  let preparation;
  if (!options.evaluateOnly) preparation = await prepareInput({ includeTarball: options.run || options.prepareOnly });
  if (options.contractOnly) {
    const manifest = JSON.parse(await readFile(join(inputRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.publicOnly, true);
    assert.equal(manifest.network, false);
    assert.equal(manifest.credentials, false);
    assert.ok(manifest.allowedFiles.every((file) => !/(?:^|\/)(?:packages|node_modules)(?:\/|$)/u.test(file)));
    const report = { format: "premise-isolated-codex-experiment/1", status: "PASS", agentLaunched: false, input: preparation };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(report, null, 2));
  } else if (options.prepareOnly) {
    const report = { format: "premise-isolated-codex-experiment/1", status: "READY", agentLaunched: false, input: preparation };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(report, null, 2));
  } else if (options.evaluateOnly) {
    const evaluation = await evaluateCandidate();
    const report = { format: "premise-isolated-codex-experiment/1", ...evaluation, inputRoot: "input", candidateRoot: "candidate" };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (!evaluation.success) process.exitCode = 1;
  } else {
    const runResult = await launchAgent();
    const report = { format: "premise-isolated-codex-experiment/1", ...runResult, inputRoot: "input", candidateRoot: "candidate", packageArtifact: preparation.packageArtifact };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (runResult.status === "FAIL") process.exitCode = 1;
  }
}
