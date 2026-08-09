import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ReferenceProtocol } from "../../packages/reference-ts/dist/index.js";
import { FilesystemValidator } from "../../packages/validator-filesystem/dist/index.js";
import { GitValidator } from "../../packages/validator-git/dist/index.js";

const OUTPUT = new URL("./results.json", import.meta.url);
const SPEC_VERSION = "premise/0.1";
const BASE_TIME = "2026-08-09T19:20:00Z";
const CHANGE_TIME = "2026-08-09T19:20:01Z";
const SEED = "premise-real-world-2026-08-09";
const GIT_INITIAL_DATE = "2026-08-09T19:20:00+0000";
const GIT_CHANGE_DATE = "2026-08-09T19:20:01+0000";

const SCENARIOS = [
  { id: "fs-control", storage: "filesystem", category: "control", mutation: "none", signal: "none", target: "root", derived: false, expected: { safeToUse: true, decision: "USE", targetStatus: "FRESH", revalidationResult: null, recoveryCandidate: false } },
  { id: "fs-content-changed", storage: "filesystem", category: "content-changed", mutation: "content", signal: "target", target: "root", derived: false, expected: { safeToUse: false, decision: "REJECT", targetStatus: "INVALID", revalidationResult: "CHANGED", recoveryCandidate: false } },
  { id: "fs-deleted", storage: "filesystem", category: "deleted", mutation: "delete", signal: "target", target: "root", derived: false, expected: { safeToUse: false, decision: "REJECT", targetStatus: "INVALID", revalidationResult: "MISSING", recoveryCandidate: false } },
  { id: "fs-unrelated-change", storage: "filesystem", category: "unrelated-change", mutation: "unrelated", signal: "unrelated", target: "root", derived: false, expected: { safeToUse: true, decision: "USE", targetStatus: "FRESH", revalidationResult: "CHANGED", recoveryCandidate: false } },
  { id: "fs-false-source-changed", storage: "filesystem", category: "false-SourceChanged", mutation: "unrelated", signal: "target", target: "root", derived: false, expected: { safeToUse: true, decision: "USE", targetStatus: "FRESH", revalidationResult: "UNCHANGED", recoveryCandidate: true } },
  { id: "fs-derived-content-changed", storage: "filesystem", category: "derived-dependency", mutation: "content", signal: "target", target: "derived", derived: true, expected: { safeToUse: false, decision: "REJECT", targetStatus: "INVALID", revalidationResult: "CHANGED", recoveryCandidate: false } },
  { id: "fs-derived-false-source-changed", storage: "filesystem", category: "derived-dependency", mutation: "unrelated", signal: "target", target: "derived", derived: true, expected: { safeToUse: true, decision: "USE", targetStatus: "FRESH", revalidationResult: "UNCHANGED", recoveryCandidate: true } },
  { id: "git-control", storage: "git", category: "control", mutation: "none", signal: "none", target: "root", derived: false, expected: { safeToUse: true, decision: "USE", targetStatus: "FRESH", revalidationResult: null, recoveryCandidate: false } },
  { id: "git-content-changed", storage: "git", category: "content-changed", mutation: "content", signal: "target", target: "root", derived: false, expected: { safeToUse: false, decision: "REJECT", targetStatus: "INVALID", revalidationResult: "CHANGED", recoveryCandidate: false } },
  { id: "git-deleted", storage: "git", category: "deleted", mutation: "delete", signal: "target", target: "root", derived: false, expected: { safeToUse: false, decision: "REJECT", targetStatus: "INVALID", revalidationResult: "MISSING", recoveryCandidate: false } },
  { id: "git-unrelated-change", storage: "git", category: "unrelated-change", mutation: "unrelated", signal: "unrelated", target: "root", derived: false, expected: { safeToUse: true, decision: "USE", targetStatus: "FRESH", revalidationResult: "CHANGED", recoveryCandidate: false } },
  { id: "git-false-source-changed", storage: "git", category: "false-SourceChanged", mutation: "unrelated", signal: "target", target: "root", derived: false, expected: { safeToUse: true, decision: "USE", targetStatus: "FRESH", revalidationResult: "UNCHANGED", recoveryCandidate: true } },
  { id: "git-derived-content-changed", storage: "git", category: "derived-dependency", mutation: "content", signal: "target", target: "derived", derived: true, expected: { safeToUse: false, decision: "REJECT", targetStatus: "INVALID", revalidationResult: "CHANGED", recoveryCandidate: false } },
  { id: "git-derived-false-source-changed", storage: "git", category: "derived-dependency", mutation: "unrelated", signal: "target", target: "derived", derived: true, expected: { safeToUse: true, decision: "USE", targetStatus: "FRESH", revalidationResult: "UNCHANGED", recoveryCandidate: true } }
];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "PREMiSE Real-World Benchmark",
  GIT_AUTHOR_EMAIL: "premise-benchmark@example.invalid",
  GIT_COMMITTER_NAME: "PREMiSE Real-World Benchmark",
  GIT_COMMITTER_EMAIL: "premise-benchmark@example.invalid"
};

function fileUri(filePath) {
  return pathToFileURL(filePath).href;
}

function gitUri(repositoryPath, objectPath) {
  const repositoryUri = pathToFileURL(repositoryPath).href.replace(/^file:/, "git+file:");
  return `${repositoryUri}#${encodeURIComponent(objectPath)}`;
}

function git(repositoryPath, args, date = GIT_CHANGE_DATE) {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    cwd: repositoryPath,
    encoding: "utf8",
    env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function createFilesystemFixture(scenario) {
  const root = await mkdtemp(path.join(tmpdir(), "premise-real-world-fs-"));
  const sourceFile = path.join(root, "source.txt");
  const unrelatedFile = path.join(root, "unrelated.txt");
  await writeFile(sourceFile, "source-v1\n", "utf8");
  await writeFile(unrelatedFile, "unrelated-v1\n", "utf8");

  return {
    storage: "filesystem",
    sourceUri: fileUri(sourceFile),
    unrelatedUri: fileUri(unrelatedFile),
    cachedContent: await readFile(sourceFile, "utf8"),
    async mutate() {
      if (scenario.mutation === "content") await writeFile(sourceFile, "source-v2\n", "utf8");
      else if (scenario.mutation === "delete") await rm(sourceFile, { force: true });
      else if (scenario.mutation === "unrelated") await writeFile(unrelatedFile, "unrelated-v2\n", "utf8");
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function createGitFixture(scenario) {
  const repositoryPath = await mkdtemp(path.join(tmpdir(), "premise-real-world-git-"));
  const sourceFile = path.join(repositoryPath, "source.txt");
  const unrelatedFile = path.join(repositoryPath, "unrelated.txt");
  try {
    git(repositoryPath, ["init", "-q", "-b", "main"], GIT_INITIAL_DATE);
    git(repositoryPath, ["config", "user.name", "PREMiSE Real-World Benchmark"]);
    git(repositoryPath, ["config", "user.email", "premise-benchmark@example.invalid"]);
    git(repositoryPath, ["config", "core.autocrlf", "false"]);
    git(repositoryPath, ["config", "core.eol", "lf"]);
    git(repositoryPath, ["config", "commit.gpgSign", "false"]);
    await writeFile(sourceFile, "source-v1\n", "utf8");
    await writeFile(unrelatedFile, "unrelated-v1\n", "utf8");
    git(repositoryPath, ["add", "--", "source.txt", "unrelated.txt"], GIT_INITIAL_DATE);
    git(repositoryPath, ["commit", "-qm", "initial", "--no-verify"], GIT_INITIAL_DATE);

    return {
      storage: "git",
      sourceUri: gitUri(repositoryPath, "source.txt"),
      unrelatedUri: gitUri(repositoryPath, "unrelated.txt"),
      cachedContent: await readFile(sourceFile, "utf8"),
      async mutate() {
        if (scenario.mutation === "content") {
          await writeFile(sourceFile, "source-v2\n", "utf8");
          git(repositoryPath, ["add", "--", "source.txt"]);
          git(repositoryPath, ["commit", "-qm", "change source", "--no-verify"]);
        } else if (scenario.mutation === "delete") {
          git(repositoryPath, ["rm", "-q", "--", "source.txt"]);
          git(repositoryPath, ["commit", "-qm", "delete source", "--no-verify"]);
        } else if (scenario.mutation === "unrelated") {
          await writeFile(unrelatedFile, "unrelated-v2\n", "utf8");
          git(repositoryPath, ["add", "--", "unrelated.txt"]);
          git(repositoryPath, ["commit", "-qm", "change unrelated", "--no-verify"]);
        }
      },
      async cleanup() {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(repositoryPath, { recursive: true, force: true });
    throw error;
  }
}

async function createFixture(scenario) {
  return scenario.storage === "filesystem" ? createFilesystemFixture(scenario) : createGitFixture(scenario);
}

function emptyCallCounts() {
  return {
    filesystem: { versionFor: 0, validate: 0 },
    git: { versionFor: 0, validate: 0 }
  };
}

function instrumentValidator(id, validator, calls) {
  const originalVersionFor = validator.versionFor.bind(validator);
  validator.versionFor = (...args) => {
    calls[id].versionFor += 1;
    return originalVersionFor(...args);
  };
  const originalValidate = validator.validate.bind(validator);
  validator.validate = async (...args) => {
    calls[id].validate += 1;
    return originalValidate(...args);
  };
  return validator;
}

function sourceReference(sourceUri, version, validatorId) {
  return {
    sourceUri,
    observedAt: BASE_TIME,
    version,
    validator: { id: validatorId, operation: validatorId === "filesystem" ? "sha256" : "rev-parse" }
  };
}

function rootEnvelope(memoryId, sourceUri, version, validatorId) {
  return {
    specVersion: SPEC_VERSION,
    memoryId,
    provenance: [sourceReference(sourceUri, version, validatorId)],
    validity: { status: "FRESH", checkedAt: BASE_TIME, policy: "VERSIONED" },
    dependsOn: []
  };
}

function derivedEnvelope(memoryId, dependencyId) {
  return {
    specVersion: SPEC_VERSION,
    memoryId,
    validity: { status: "FRESH", checkedAt: BASE_TIME, policy: "MANUAL" },
    dependsOn: [dependencyId]
  };
}

function validatorFor(storage, validators) {
  return storage === "filesystem" ? validators.filesystem : validators.git;
}

async function observedVersion(validator, sourceUri, fallback) {
  try {
    return await validator.versionFor(sourceUri);
  } catch {
    return { scheme: fallback.scheme, token: `missing:${fallback.token}` };
  }
}

function decisionFor(check) {
  if (check.decision === "USABLE") return "USE";
  if (check.decision === "REJECT") return "REJECT";
  return "REVALIDATE";
}

function baseEpisode(strategy, scenario, fields) {
  const expected = scenario.expected;
  const unsafeAction = !expected.safeToUse && fields.decision === "USE";
  const falseRejection = expected.safeToUse && fields.decision !== "USE";
  const recovered = expected.recoveryCandidate && fields.decision === "USE";
  const validatedRecovery = recovered && fields.revalidationResult === "UNCHANGED";
  return {
    strategy,
    scenarioId: scenario.id,
    storage: scenario.storage,
    category: scenario.category,
    mutation: scenario.mutation,
    signal: scenario.signal,
    target: scenario.target,
    derived: scenario.derived,
    decision: fields.decision,
    targetStatus: fields.targetStatus,
    expectedDecision: expected.decision,
    expectedTargetStatus: expected.targetStatus,
    safeToUse: expected.safeToUse,
    unsafeAction,
    falseRejection,
    correctDecision: fields.decision === expected.decision,
    recoveryCandidate: expected.recoveryCandidate,
    recovered,
    validatedRecovery,
    revalidation: {
      requested: expected.revalidationResult !== null,
      expectedResult: expected.revalidationResult,
      result: fields.revalidationResult,
      status: fields.revalidationStatus,
      memoryIds: fields.validationMemoryIds,
      eventIds: fields.validationEventIds,
      calls: fields.validationCalls
    },
    validatorCalls: fields.validatorCalls,
    memoryReadCalls: fields.memoryReadCalls,
    latencyMs: roundMs(fields.latencyMs),
    history: fields.history,
    isolation: fields.isolation,
    sourceVersions: fields.sourceVersions,
    note: fields.note
  };
}

async function runBaseline(scenario) {
  const fixture = await createFixture(scenario);
  try {
    await fixture.mutate();
    const started = performance.now();
    const cachedContent = fixture.cachedContent;
    if (cachedContent.length === 0) throw new Error(`empty cached fixture for ${scenario.id}`);
    const decision = "USE";
    const latencyMs = performance.now() - started;
    return baseEpisode("No protocol", scenario, {
      decision,
      targetStatus: "NOT_TRACKED",
      revalidationResult: null,
      revalidationStatus: null,
      validationMemoryIds: [],
      validationEventIds: [],
      validationCalls: 0,
      validatorCalls: emptyCallCounts(),
      memoryReadCalls: 1,
      latencyMs,
      history: { preserved: false, length: 0, eventTypes: [] },
      isolation: null,
      sourceVersions: { initial: null, event: null },
      note: "cached content is used without source validation"
    });
  } finally {
    await fixture.cleanup();
  }
}

async function runPremise(scenario) {
  const fixture = await createFixture(scenario);
  const calls = emptyCallCounts();
  try {
    const validators = {
      filesystem: instrumentValidator("filesystem", new FilesystemValidator(), calls),
      git: instrumentValidator("git", new GitValidator(), calls)
    };
    const sourceValidator = validatorFor(scenario.storage, validators);
    const protocol = new ReferenceProtocol(() => BASE_TIME);
    protocol.registerValidator(validators.filesystem);
    protocol.registerValidator(validators.git);

    const rootId = `memory:${scenario.id}:root`;
    const outsideId = `memory:${scenario.id}:unrelated`;
    const derivedId = `memory:${scenario.id}:derived`;
    const initialTargetVersion = await sourceValidator.versionFor(fixture.sourceUri);
    const initialOutsideVersion = await sourceValidator.versionFor(fixture.unrelatedUri);
    protocol.register(rootEnvelope(rootId, fixture.sourceUri, initialTargetVersion, scenario.storage));
    protocol.register(rootEnvelope(outsideId, fixture.unrelatedUri, initialOutsideVersion, scenario.storage));
    if (scenario.derived) protocol.derive(derivedEnvelope(derivedId, rootId));
    const targetId = scenario.derived ? derivedId : rootId;
    const beforeChange = protocol.check([targetId]).items[0];
    if (beforeChange.status !== "FRESH" || beforeChange.decision !== "USABLE") throw new Error(`fixture did not start fresh: ${scenario.id}`);

    await fixture.mutate();
    const signalUri = scenario.signal === "target" ? fixture.sourceUri : scenario.signal === "unrelated" ? fixture.unrelatedUri : null;
    const signalVersion = signalUri === null ? null : await observedVersion(sourceValidator, signalUri, signalUri === fixture.sourceUri ? initialTargetVersion : initialOutsideVersion);
    const started = performance.now();
    let propagation = null;
    let validationReport = null;
    if (signalUri !== null) {
      propagation = protocol.signal({
        specVersion: SPEC_VERSION,
        eventId: `source-changed:${scenario.id}`,
        type: "SourceChanged",
        occurredAt: CHANGE_TIME,
        payload: { sourceUri: signalUri, version: signalVersion }
      });
      if (propagation.roots.length > 0) validationReport = await protocol.validate(propagation.roots);
    }
    const check = protocol.check([targetId]).items[0];
    const latencyMs = performance.now() - started;
    const validationItem = validationReport?.items[0] ?? null;
    const historyEvents = protocol.history(targetId);
    const affected = propagation?.affected ?? [];
    const targetAffected = scenario.signal === "target" ? affected.includes(rootId) : !affected.includes(rootId) && !affected.includes(derivedId);
    const outsideIsolated = !affected.includes(outsideId);
    const targetIsFreshForUnrelatedSignal = scenario.signal !== "unrelated" || check.status === "FRESH";
    const isolationPassed = scenario.signal === "unrelated"
      ? targetAffected && affected.includes(outsideId) && targetIsFreshForUnrelatedSignal
      : targetAffected && outsideIsolated && check.status === scenario.expected.targetStatus;

    return baseEpisode("PREMiSE", scenario, {
      decision: decisionFor(check),
      targetStatus: check.status,
      revalidationResult: validationItem?.result ?? null,
      revalidationStatus: validationItem?.status ?? null,
      validationMemoryIds: validationReport ? [...propagation.roots] : [],
      validationEventIds: validationReport ? [...validationReport.eventIds] : [],
      validationCalls: calls[scenario.storage].validate,
      validatorCalls: calls,
      memoryReadCalls: 1,
      latencyMs,
      history: { preserved: historyEvents.length > 0, length: historyEvents.length, eventTypes: historyEvents.map((event) => event.type) },
      isolation: { expected: true, passed: isolationPassed, affected, targetStatusAfter: check.status, outsideStatusAfter: protocol.states.stateOf(outsideId)?.status ?? "UNKNOWN" },
      sourceVersions: { initial: initialTargetVersion, event: signalVersion },
      note: "real validator result gates protocol.check before use"
    });
  } finally {
    await fixture.cleanup();
  }
}

function roundMs(value) {
  return Number(value.toFixed(3));
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function rate(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function callTotals(episodes) {
  const byValidator = {
    filesystem: { versionFor: 0, validate: 0 },
    git: { versionFor: 0, validate: 0 }
  };
  for (const episode of episodes) {
    for (const id of Object.keys(byValidator)) {
      byValidator[id].versionFor += episode.validatorCalls[id].versionFor;
      byValidator[id].validate += episode.validatorCalls[id].validate;
    }
  }
  const versionFor = Object.values(byValidator).reduce((sum, calls) => sum + calls.versionFor, 0);
  const validate = Object.values(byValidator).reduce((sum, calls) => sum + calls.validate, 0);
  return { byValidator, versionFor, validate, total: versionFor + validate };
}

function metrics(strategy, episodes) {
  const safeCases = episodes.filter((episode) => episode.safeToUse);
  const recoveryCases = episodes.filter((episode) => episode.recoveryCandidate);
  const validationCases = episodes.filter((episode) => episode.revalidation.requested);
  const isolationCases = episodes.filter((episode) => episode.isolation?.expected);
  const durations = episodes.map((episode) => episode.latencyMs);
  const calls = callTotals(episodes);
  const histories = episodes.filter((episode) => episode.history.preserved);
  return {
    strategy,
    episodes: episodes.length,
    denominators: {
      safeToUse: safeCases.length,
      unsafeToUse: episodes.length - safeCases.length,
      recoveryCandidates: recoveryCases.length,
      validationCases: validationCases.length,
      isolationCases: isolationCases.length
    },
    security: {
      unsafeActions: episodes.filter((episode) => episode.unsafeAction).length,
      unsafeActionRate: rate(episodes.filter((episode) => episode.unsafeAction).length, episodes.length),
      falseRejections: episodes.filter((episode) => episode.falseRejection).length,
      falseRejectionRate: rate(episodes.filter((episode) => episode.falseRejection).length, safeCases.length),
      correctDecisions: episodes.filter((episode) => episode.correctDecision).length,
      correctDecisionRate: rate(episodes.filter((episode) => episode.correctDecision).length, episodes.length)
    },
    recovery: {
      candidates: recoveryCases.length,
      safeRecoveries: recoveryCases.filter((episode) => episode.recovered).length,
      safeRecoveryRate: rate(recoveryCases.filter((episode) => episode.recovered).length, recoveryCases.length),
      validatedRecoveries: recoveryCases.filter((episode) => episode.validatedRecovery).length,
      validatedRecoveryRate: rate(recoveryCases.filter((episode) => episode.validatedRecovery).length, recoveryCases.length)
    },
    validation: {
      cases: validationCases.length,
      resultMatches: validationCases.filter((episode) => episode.revalidation.result === episode.revalidation.expectedResult).length,
      resultMatchRate: rate(validationCases.filter((episode) => episode.revalidation.result === episode.revalidation.expectedResult).length, validationCases.length),
      protocolValidateCalls: calls.validate
    },
    validatorCalls: calls,
    latencyMs: { p50: roundMs(percentile(durations, 0.5)), p95: roundMs(percentile(durations, 0.95)) },
    history: {
      episodesWithHistory: histories.length,
      preservationRate: rate(histories.length, episodes.length),
      totalTargetEvents: episodes.reduce((sum, episode) => sum + episode.history.length, 0),
      averageTargetEvents: roundMs(rate(episodes.reduce((sum, episode) => sum + episode.history.length, 0), episodes.length))
    },
    isolation: {
      cases: isolationCases.length,
      measured: strategy === "PREMiSE",
      passed: strategy === "PREMiSE" ? isolationCases.filter((episode) => episode.isolation.passed).length : null,
      passRate: strategy === "PREMiSE" ? rate(isolationCases.filter((episode) => episode.isolation.passed).length, isolationCases.length) : null
    },
    memoryReadCalls: episodes.reduce((sum, episode) => sum + episode.memoryReadCalls, 0)
  };
}

export async function run() {
  const baseline = [];
  const premise = [];
  for (const scenario of SCENARIOS) {
    baseline.push(await runBaseline(scenario));
    premise.push(await runPremise(scenario));
  }
  const result = {
    format: "premise-real-world-benchmark/0.1",
    suite: "paired-real-fixtures-v1",
    runner: "node24",
    runtime: { node: process.versions.node, git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim() },
    seed: SEED,
    determinism: {
      networkAccess: false,
      fixedProtocolTime: BASE_TIME,
      fixedChangeTime: CHANGE_TIME,
      fixedGitDates: [GIT_INITIAL_DATE, GIT_CHANGE_DATE],
      temporaryFixturesCleaned: true,
      stableScenarioOrder: true
    },
    integrations: {
      referenceProtocol: "packages/reference-ts/dist/index.js",
      validators: {
        filesystem: "packages/validator-filesystem/dist/index.js",
        git: "packages/validator-git/dist/index.js"
      },
      fixtures: ["temporary real files", "temporary Git repository with deterministic commits"]
    },
    scenarioCount: SCENARIOS.length,
    scenarios: SCENARIOS,
    pairedMetrics: [metrics("No protocol", baseline), metrics("PREMiSE", premise)],
    perEpisode: [...baseline, ...premise],
    limitations: [
      "The baseline intentionally uses cached content without a source validator.",
      "Latency is local decision-path latency; temporary fixture creation is excluded.",
      "Validator versionFor calls include initial registration, event version observation, and reads performed inside validate()."
    ]
  };
  await mkdir(new URL(".", OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ format: result.format, scenarios: result.scenarioCount, pairedMetrics: result.pairedMetrics }, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
