import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectEvidenceDirectory, loadAcceptanceManifest, listEvidenceRequirements } from "./ga-gate.mjs";

function isPathInside(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child));
  return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function parseMap(value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) throw new Error(`--map must use target=source: ${value}`);
  return { target: value.slice(0, separator), source: value.slice(separator + 1) };
}

export function parseArgs(argv) {
  let input;
  let output;
  let commit;
  let source;
  let generatedAt;
  let help = false;
  const mappings = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    if (flag === "--help" || flag === "-h") {
      help = true;
      continue;
    }
    const valueFor = (name) => {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) throw new Error(`${name} requires a value`);
      if (inlineValue === undefined) index += 1;
      return value;
    };
    if (flag === "--input") input = valueFor(flag);
    else if (flag === "--output") output = valueFor(flag);
    else if (flag === "--commit") commit = valueFor(flag);
    else if (flag === "--source") source = valueFor(flag);
    else if (flag === "--generated-at") generatedAt = valueFor(flag);
    else if (flag === "--map") mappings.push(parseMap(valueFor(flag)));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!help && (!input || !output)) throw new Error("--input and --output are required");
  return { input, output, commit, source, generatedAt, mappings, help };
}

async function walkFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(absolutePath, relativePath));
    else if (entry.isFile()) files.push({ relativePath, absolutePath });
  }
  return files;
}

async function fileDetails(filePath) {
  const contents = await readFile(filePath);
  return {
    bytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex")
  };
}

function safeRelativeReference(value) {
  return typeof value === "string" && value.trim().length > 0 && !isAbsolute(value) && !value.split(/[\\/]/u).includes("..");
}

function referencedFiles(document) {
  return [
    ["trace.path", document?.trace?.path],
    ["backup.path", document?.backup?.path],
    ["spec.path", document?.spec?.path]
  ].filter(([, value], index, references) => typeof value === "string" && references.findIndex(([, candidate]) => candidate === value) === index)
    .map(([field, path]) => ({ field, path }));
}

async function resolveReferencedSource({ inputRoot, reportSource, field, reference, files, failures, target }) {
  if (!safeRelativeReference(reference)) {
    failures.push({ target, code: "unsafe-dependency", message: `${field} must reference a relative file inside the input directory: ${reference}` });
    return null;
  }
  const exact = new Map();
  for (const candidate of [resolve(dirname(reportSource.absolutePath), reference), resolve(inputRoot, reference)]) {
    if (isPathInside(inputRoot, candidate)) {
      const match = files.find((file) => resolve(file.absolutePath) === candidate);
      if (match) exact.set(match.absolutePath, match);
    }
  }
  if (exact.size === 1) return [...exact.values()][0];
  if (exact.size > 1) {
    failures.push({ target, code: "ambiguous-dependency", message: `${field} resolves to more than one input file: ${reference}` });
    return null;
  }
  const candidates = files.filter((file) => basename(file.relativePath) === basename(reference));
  if (candidates.length !== 1) {
    failures.push({
      target,
      code: candidates.length === 0 ? "missing-dependency" : "ambiguous-dependency",
      message: candidates.length === 0 ? `${field} points to a missing raw evidence file: ${reference}` : `${field} points to an ambiguous raw evidence basename: ${reference}`,
      ...(candidates.length > 1 ? { candidates: candidates.map((candidate) => candidate.relativePath) } : {})
    });
    return null;
  }
  return candidates[0];
}

async function collectReferencedFiles({ inputRoot, outputRoot, files, copiedReports, failures }) {
  const dependencies = [];
  const copied = new Map();
  for (const [target, report] of copiedReports) {
    let document;
    try {
      document = JSON.parse(await readFile(report.targetPath, "utf8"));
    } catch {
      continue;
    }
    for (const { field, path: reference } of referencedFiles(document)) {
      const sourceFile = await resolveReferencedSource({ inputRoot, reportSource: report.sourceFile, field, reference, files, failures, target });
      if (!sourceFile) continue;
      const targetPath = resolve(outputRoot, reference);
      if (!isPathInside(outputRoot, targetPath)) {
        failures.push({ target, code: "unsafe-dependency", message: `${field} escapes the output directory: ${reference}` });
        continue;
      }
      const existing = copied.get(targetPath);
      if (existing !== undefined) {
        if (resolve(existing.sourceFile.absolutePath) !== resolve(sourceFile.absolutePath)) failures.push({ target, code: "dependency-conflict", message: `Different input files claim the same raw evidence path: ${reference}` });
        dependencies.push({ evidence: target, field, path: reference, source: sourceFile.relativePath, status: "reused", ...existing.details });
        continue;
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourceFile.absolutePath, targetPath);
      const details = await fileDetails(targetPath);
      copied.set(targetPath, { sourceFile, details });
      dependencies.push({ evidence: target, field, path: reference, source: sourceFile.relativePath, status: "copied", ...details });
    }
  }
  return dependencies;
}

async function prepareOutputDirectory(outputRoot) {
  try {
    const info = await stat(outputRoot);
    if (!info.isDirectory()) throw new Error(`Output path is not a directory: ${outputRoot}`);
    if ((await readdir(outputRoot)).length > 0) throw new Error(`Output directory must be empty before collecting evidence: ${outputRoot}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(outputRoot, { recursive: true });
  }
}

async function resolveSource({ inputRoot, target, explicitSource, files, failures }) {
  if (explicitSource !== undefined) {
    const sourcePath = isAbsolute(explicitSource) ? resolve(explicitSource) : resolve(inputRoot, explicitSource);
    if (!isPathInside(inputRoot, sourcePath)) {
      failures.push({ target, code: "unsafe-source", message: `Mapped source escapes the input directory: ${explicitSource}` });
      return null;
    }
    try {
      const info = await stat(sourcePath);
      if (!info.isFile()) {
        failures.push({ target, code: "source-not-file", message: `Mapped source is not a regular file: ${explicitSource}` });
        return null;
      }
      return { relativePath: relative(inputRoot, sourcePath).replaceAll("\\", "/"), absolutePath: sourcePath };
    } catch {
      failures.push({ target, code: "source-missing", message: `Mapped source does not exist: ${explicitSource}` });
      return null;
    }
  }

  const directPath = resolve(inputRoot, target);
  const direct = files.find((file) => resolve(file.absolutePath) === directPath);
  if (direct) return direct;
  const candidates = files.filter((file) => basename(file.relativePath) === target);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    failures.push({
      target,
      code: "ambiguous-source",
      message: `Multiple input artifacts have basename ${target}; use --map ${target}=relative/path to select one.`,
      candidates: candidates.map((candidate) => candidate.relativePath)
    });
    return null;
  }
  failures.push({ target, code: "missing-source", message: `No input artifact was found for required evidence ${target}.` });
  return null;
}

export async function collectGaEvidence({
  inputDir,
  outputDir,
  mappings = [],
  commit = process.env.GITHUB_SHA ?? null,
  source = null,
  generatedAt = new Date().toISOString(),
  manifest
}) {
  const inputRoot = resolve(inputDir);
  const outputRoot = resolve(outputDir);
  const inputInfo = await stat(inputRoot);
  if (!inputInfo.isDirectory()) throw new Error(`Input path is not a directory: ${inputRoot}`);
  if (isPathInside(inputRoot, outputRoot)) throw new Error("Output directory must not be inside the input directory.");
  await prepareOutputDirectory(outputRoot);

  const resolvedManifest = manifest ?? await loadAcceptanceManifest();
  const requirements = listEvidenceRequirements(resolvedManifest);
  const requiredNames = new Set(requirements.map((requirement) => requirement.name));
  const failures = [];
  const mappingByTarget = new Map();
  for (const mapping of mappings) {
    if (!requiredNames.has(mapping.target)) {
      failures.push({ target: mapping.target, code: "unknown-target", message: `Mapping target is not a required GA evidence file: ${mapping.target}` });
      continue;
    }
    if (mappingByTarget.has(mapping.target)) {
      failures.push({ target: mapping.target, code: "duplicate-mapping", message: `More than one mapping was supplied for ${mapping.target}.` });
      continue;
    }
    mappingByTarget.set(mapping.target, mapping.source);
  }

  const files = await walkFiles(inputRoot);
  const collected = [];
  const copiedReports = new Map();
  for (const requirement of requirements) {
    const sourceFile = await resolveSource({
      inputRoot,
      target: requirement.name,
      explicitSource: mappingByTarget.get(requirement.name),
      files,
      failures
    });
    if (!sourceFile) {
      collected.push({ evidence: requirement.name, status: "missing", source: null, bytes: 0, sha256: null });
      continue;
    }
    const targetPath = resolve(outputRoot, requirement.name);
    if (!isPathInside(outputRoot, targetPath)) {
      failures.push({ target: requirement.name, code: "unsafe-target", message: `Evidence target escapes the output directory: ${requirement.name}` });
      collected.push({ evidence: requirement.name, status: "rejected", source: sourceFile.relativePath, bytes: 0, sha256: null });
      continue;
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourceFile.absolutePath, targetPath);
    const details = await fileDetails(targetPath);
    const status = details.bytes > 0 ? "copied" : "copied-empty";
    if (details.bytes === 0) failures.push({ target: requirement.name, code: "empty-source", message: `Input artifact for ${requirement.name} is empty; it was copied without inventing content.` });
    collected.push({ evidence: requirement.name, status, source: sourceFile.relativePath, ...details });
    copiedReports.set(requirement.name, { sourceFile, targetPath });
  }

  const dependencies = await collectReferencedFiles({ inputRoot, outputRoot, files, copiedReports, failures });
  const contract = await inspectEvidenceDirectory(outputRoot, resolvedManifest);
  const allFailures = [...failures, ...contract.failures];
  const report = {
    schema: "premise/ga-evidence-collection/1",
    commit,
    generatedAt,
    source: source ?? inputRoot,
    trace: {
      inputDirectory: inputRoot,
      mappings: [...mappingByTarget.entries()].map(([target, mappedSource]) => ({ target, source: mappedSource })),
      files: collected.map(({ evidence, source: fileSource, status, bytes, sha256 }) => ({ evidence, source: fileSource, status, bytes, sha256 })),
      dependencies
    },
    manifest: {
      schemaVersion: resolvedManifest.schemaVersion,
      release: resolvedManifest.release
    },
    files: collected,
    dependencies,
    contract: {
      required: contract.required,
      present: contract.present,
      verified: contract.verified,
      independent: contract.independent,
      eligible: contract.eligible,
      presence: contract.presence,
      verifiedAll: contract.verifiedAll,
      independentRequired: contract.independentRequired,
      independentAll: contract.independentAll,
      eligibleAll: contract.eligibleAll,
      failures: contract.failures,
      incompatibilities: contract.incompatibilities
    },
    failures: allFailures
  };
  await writeFile(resolve(outputRoot, "collection-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, outputDirectory: outputRoot, exitCode: allFailures.length > 0 ? 1 : 0 };
}

function usage() {
  return [
    "Usage: node scripts/collect-ga-evidence.mjs --input DIR --output DIR [options]",
    "",
    "Copies only real required artifacts. Missing artifacts are reported and never created.",
    "Options:",
    "  --map TARGET=SOURCE       map a required evidence name to an input-relative file (repeatable)",
    "  --commit SHA              collection metadata only; never injected into copied artifacts",
    "  --source VALUE            collection metadata only",
    "  --generated-at ISO        collection timestamp (defaults to now)",
    "  --help"
  ].join("\n");
}

function isMain() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exitCode = 0;
    } else {
      const result = await collectGaEvidence(options);
      console.log(JSON.stringify(result, null, 2));
      for (const item of result.failures) console.error(`GA evidence collector: ${item.message}`);
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    console.error(`GA evidence collector: ${error.message}`);
    process.exitCode = 1;
  }
}
