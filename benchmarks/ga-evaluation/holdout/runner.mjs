import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOLDOUT_ATTESTATION_FORMAT,
  HOLDOUT_PROTOCOL,
  HOLDOUT_RUNNER_VERSION,
  HoldoutContractError,
  answerDigest,
  answersEqual,
  assertExternalUrl,
  assertSha256,
  assertCandidateMessage,
  candidateCommitFromEnvironment,
  percentile,
  publicTask,
  safeExternalUrl,
  sha256Bytes,
  sha256Text,
  stableJson,
  validateExternalManifestInput,
  validateLabelSet,
  validateManifest,
  validateTaskSet,
  verifyIndependentAttestation
} from "./contract.mjs";

const MAX_LINE_BYTES = 1_048_576;

function optionValue(args, name, fallback) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function flag(args, name) {
  return args.includes(name);
}

function fail(message, code = "HOLDOUT_RUN_FAILED") {
  const error = new Error(`[ga-holdout] ${message}`);
  error.code = code;
  throw error;
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail(`${label} is not valid UTF-8 JSON`);
  }
}

async function readBoundedBody(response, maxBytes, label) {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) fail(`${label} exceeds the configured ${maxBytes}-byte limit`);
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) fail(`${label} exceeds the configured ${maxBytes}-byte limit`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        fail(`${label} exceeds the configured ${maxBytes}-byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchPinnedBytes(url, expectedSha256, label, { bearerToken, maxBytes }) {
  assertExternalUrl(url, `${label} URL`);
  assertSha256(expectedSha256, `${label} SHA-256`);
  const headers = {
    accept: "application/json",
    "user-agent": "premise-ga-external-holdout/1"
  };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    fail(`${label} download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertExternalUrl(response.url, `${label} final URL`);
  if (!response.ok) fail(`${label} download failed with HTTP ${response.status}`);
  const bytes = await readBoundedBody(response, maxBytes, label);
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== expectedSha256) fail(`${label} SHA-256 mismatch; expected ${expectedSha256}, got ${actualSha256}`);
  return { bytes, actualSha256, finalUrl: safeExternalUrl(response.url) };
}

function candidateEnvironment(environment = process.env) {
  const allowed = ["PATH", "Path", "SystemRoot", "ComSpec", "TEMP", "TMP", "LANG", "LC_ALL"];
  const result = Object.fromEntries(allowed.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]));
  result.PREMISE_HOLDOUT_PROTOCOL = HOLDOUT_PROTOCOL;
  result.GA_HOLDOUT_PROTOCOL = HOLDOUT_PROTOCOL;
  return result;
}

function writeLine(stream, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) fail("candidate protocol message exceeds the 1 MiB line limit");
  if (stream.write(serialized)) return undefined;
  return new Promise((resolvePromise, reject) => {
    stream.once("drain", resolvePromise);
    stream.once("error", reject);
  });
}

function nextLine(iterator, timeoutMs) {
  let timer;
  return Promise.race([
    iterator.next().then((result) => {
      if (result.done) fail("candidate closed stdout before answering");
      if (Buffer.byteLength(result.value, "utf8") > MAX_LINE_BYTES) fail("candidate emitted a line larger than 1 MiB");
      return result.value;
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`candidate protocol timeout after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function waitForExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function githubAdapter(manifest, environment = process.env) {
  const base = manifest.source.apiBase.replace(/\/$/u, "");
  const token = environment.GITHUB_TOKEN ?? environment.GH_TOKEN;
  const counters = { requests: 0, writeRequests: 0, byOperation: { read: 0, version: 0 } };
  async function request(task, operation) {
    if (task.source.method !== "GET") fail("holdout attempted a non-GET connector operation");
    const url = `${base}${task.source.path}`;
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "premise-ga-external-holdout/1"
    };
    if (token) headers.authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(manifest.limits.taskTimeoutMs) });
    } catch (error) {
      fail(`GitHub read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    counters.requests += 1;
    counters.byOperation[operation] += 1;
    if (response.status === 304) return { body: undefined, rawText: "", etag: response.headers.get("etag"), status: 304, url };
    const rawText = (await readBoundedBody(response, manifest.limits.maxPayloadBytes, "GitHub response")).toString("utf8");
    if (!response.ok) fail(`GitHub GET returned HTTP ${response.status}`);
    let body;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = rawText;
    }
    return { body, rawText, etag: response.headers.get("etag"), status: response.status, url };
  }
  return {
    counters,
    async read(task) {
      const result = await request(task, "read");
      const bodySha256 = sha256Text(result.rawText);
      return {
        ...result,
        bodySha256,
        version: { scheme: result.etag ? "github.etag" : "github.body-sha256", token: result.etag ?? bodySha256 },
        provenance: {
          kind: "live-source-observation",
          origin: "github-api-read-only",
          adapter: "github",
          method: "GET",
          sourceUri: safeExternalUrl(result.url),
          bodySha256,
          writeRequests: 0
        }
      };
    },
    async version(task) {
      const result = await request(task, "version");
      const bodySha256 = sha256Text(result.rawText);
      return {
        status: result.status,
        version: { scheme: result.etag ? "github.etag" : "github.body-sha256", token: result.etag ?? bodySha256 },
        provenance: {
          kind: "live-source-observation",
          origin: "github-api-read-only",
          adapter: "github",
          method: "GET",
          sourceUri: safeExternalUrl(result.url),
          bodySha256,
          writeRequests: 0
        }
      };
    }
  };
}

async function runCandidate({ candidateCommand, tasks, manifest, timeoutMs, environment }) {
  const adapter = githubAdapter(manifest, environment);
  const child = spawn(candidateCommand, {
    shell: true,
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: candidateEnvironment(environment)
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    if (stderr.join("").length < 4096) stderr.push(String(chunk).slice(0, 4096));
  });
  const responses = [];
  let fatal;
  for (const task of tasks) {
    const started = performance.now();
    const publicValue = publicTask(task);
    const publicSourceId = publicValue.source.id;
    let lastEvidence;
    let response;
    let error;
    let requests = 0;
    try {
      await writeLine(child.stdin, { type: "task", task: publicValue });
      while (true) {
        let message;
        try {
          const raw = await nextLine(iterator, timeoutMs);
          message = JSON.parse(raw);
        } catch (caught) {
          throw new Error(caught instanceof Error ? caught.message : String(caught));
        }
        assertCandidateMessage(message);
        if (message.type === "log") continue;
        if (message.type === "read" || message.type === "version") {
          if (message.sourceId !== publicSourceId) fail("candidate requested a source outside the active opaque task");
          requests += 1;
          if (message.type === "read") {
            const evidence = await adapter.read(task);
            lastEvidence = evidence;
            await writeLine(child.stdin, {
              type: "evidence",
              requestId: message.requestId ?? null,
              sourceId: publicSourceId,
              content: evidence.rawText,
              body: evidence.body,
              version: evidence.version,
              adapter: "github",
              provenance: evidence.provenance
            });
          } else {
            const evidence = await adapter.version(task);
            lastEvidence = evidence;
            await writeLine(child.stdin, {
              type: "version",
              requestId: message.requestId ?? null,
              sourceId: publicSourceId,
              version: evidence.version,
              adapter: "github",
              provenance: evidence.provenance
            });
          }
          continue;
        }
        response = {
          answer: message.answer,
          decision: message.decision ?? "USE",
          status: message.status ?? "UNKNOWN",
          version: lastEvidence?.version,
          provenance: lastEvidence?.provenance
        };
        break;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      fatal = error;
    }
    const latencyMs = performance.now() - started;
    responses.push({
      taskId: task.id,
      opaqueTaskId: publicValue.taskId,
      answer: response?.answer,
      decision: response?.decision ?? "ERROR",
      status: response?.status ?? "ERROR",
      evidenceVersion: response?.version,
      provenance: response?.provenance,
      requests,
      latencyMs: Number(latencyMs.toFixed(3)),
      ...(error === undefined ? {} : { error })
    });
    if (fatal) break;
  }
  if (fatal) {
    for (const task of tasks.slice(responses.length)) {
      const publicValue = publicTask(task);
      responses.push({ taskId: task.id, opaqueTaskId: publicValue.taskId, answer: undefined, decision: "ERROR", status: "ABORTED", requests: 0, latencyMs: 0, error: `candidate aborted: ${fatal}` });
    }
    child.kill();
  } else {
    await writeLine(child.stdin, { type: "end" });
    child.stdin.end();
  }
  lines.close();
  await waitForExit(child);
  return { responses, adapterCounters: adapter.counters, stderr: stderr.join("").slice(0, 4096), fatal };
}

function summarize(responses, labels) {
  const latencies = responses.map((response) => response.latencyMs);
  const available = responses.filter((response) => response.decision !== "REJECT" && response.decision !== "ERROR" && Object.hasOwn(response, "answer") && response.answer !== undefined);
  const correct = available.filter((response) => answersEqual(response.answer, labels.get(response.taskId).answer));
  const falsePositives = available.length - correct.length;
  const freshnessEligible = responses.filter((response) => Object.hasOwn(labels.get(response.taskId), "sourceVersion"));
  const fresh = freshnessEligible.filter((response) => response.evidenceVersion?.token === labels.get(response.taskId).sourceVersion);
  const errors = responses.filter((response) => response.error !== undefined).length;
  const requests = responses.reduce((sum, response) => sum + response.requests, 0);
  const tasks = responses.length;
  const rate = (value, denominator = tasks) => Number((denominator === 0 ? 0 : value * 100 / denominator).toFixed(2));
  return {
    strategy: "candidate",
    tasks,
    available: available.length,
    availablePer100: rate(available.length),
    correct: correct.length,
    correctPer100: rate(correct.length),
    falsePositives: falsePositives,
    falsePositivesPer100: rate(falsePositives),
    errors,
    errorsPer100: rate(errors),
    freshnessEligible: freshnessEligible.length,
    fresh: fresh.length,
    freshPer100Eligible: rate(fresh.length, freshnessEligible.length),
    requests,
    requestsPer100: rate(requests),
    p50Ms: Number(percentile(latencies, 0.5).toFixed(3)),
    p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
    p99Ms: Number(percentile(latencies, 0.99).toFixed(3))
  };
}

function tracesFor(responses, labels) {
  return responses.map((response) => {
    const label = labels.get(response.taskId);
    const available = response.decision !== "REJECT" && response.decision !== "ERROR" && Object.hasOwn(response, "answer") && response.answer !== undefined;
    const correct = available && answersEqual(response.answer, label.answer);
    const freshnessEligible = Object.hasOwn(label, "sourceVersion");
    return {
      taskId: response.taskId,
      decision: response.decision,
      status: response.status,
      available,
      correct,
      falsePositive: available && !correct,
      freshnessEligible,
      fresh: freshnessEligible && response.evidenceVersion?.token === label.sourceVersion,
      requests: response.requests,
      latencyMs: response.latencyMs,
      answerDigest: available ? answerDigest(response.answer) : undefined,
      evidenceVersion: response.evidenceVersion?.token === undefined ? undefined : sha256Text(String(response.evidenceVersion.token)),
      ...(response.error === undefined ? {} : { error: response.error })
    };
  });
}

function responseJsonl(responses) {
  return `${responses.map((response) => JSON.stringify(response)).join("\n")}\n`;
}

function candidateOnlyEvidence(reason) {
  return {
    class: "candidate",
    independent: false,
    eligibleForPublicClaim: false,
    reason
  };
}

function benchmarkEligibility(metrics, manifest) {
  const accuracyMin = manifest.thresholds?.accuracyMin ?? 0.95;
  const freshnessMin = manifest.thresholds?.freshnessMin ?? 0.99;
  const minimumTasks = 200;
  const accuracy = metrics.tasks >= minimumTasks && metrics.correctPer100 / 100 >= accuracyMin;
  const freshness = metrics.freshnessEligible > 0 && metrics.freshPer100Eligible / 100 >= freshnessMin;
  return {
    minimumTasks: { observed: metrics.tasks, required: minimumTasks, passed: metrics.tasks >= minimumTasks },
    accuracy: { observed: metrics.correctPer100 / 100, minimum: accuracyMin, passed: accuracy },
    freshness: { observed: metrics.freshPer100Eligible / 100, minimum: freshnessMin, passed: freshness },
    passed: accuracy && freshness
  };
}

async function resolveEvidenceClass({ args, manifest, hashes, responsesSha256, runSha256, candidateCommit, environment }) {
  const attestationUrl = optionValue(args, "--attestation-url", environment.PREMISE_HOLDOUT_ATTESTATION_URL);
  const attestationSha256 = optionValue(args, "--attestation-sha256", environment.PREMISE_HOLDOUT_ATTESTATION_SHA256);
  const publicKeyPem = optionValue(args, "--attestation-public-key", environment.PREMISE_HOLDOUT_ATTESTATION_PUBLIC_KEY);
  const requireIndependent = flag(args, "--require-independent") || environment.PREMISE_HOLDOUT_REQUIRE_INDEPENDENT === "1";
  if (!attestationUrl || !attestationSha256 || !publicKeyPem) {
    if (requireIndependent) fail("independent evidence was required but no external attestation URL, hash, and public key were supplied", "HOLDOUT_NOT_ELIGIBLE");
    return candidateOnlyEvidence("the run verified external data but no independently signed attestation was supplied");
  }
  if (!candidateCommit) {
    if (requireIndependent) fail("independent evidence requires PREMiSE_CANDIDATE_COMMIT or GITHUB_SHA to bind the candidate", "HOLDOUT_NOT_ELIGIBLE");
    return candidateOnlyEvidence("candidate commit is not a full SHA-1; independent attestation was not attempted");
  }
  assertExternalUrl(attestationUrl, "independent attestation URL");
  assertSha256(attestationSha256, "independent attestation SHA-256");
  const downloaded = await fetchPinnedBytes(attestationUrl, attestationSha256, "independent attestation", { bearerToken: environment.PREMISE_HOLDOUT_BEARER_TOKEN, maxBytes: manifest.limits.maxPayloadBytes });
  const attestation = (() => {
    try { return JSON.parse(downloaded.bytes.toString("utf8")); } catch { fail("independent attestation is not valid JSON"); }
  })();
  try {
    verifyIndependentAttestation(attestation, {
      manifestSha256: hashes.manifestSha256,
      taskSetSha256: hashes.taskSetSha256,
      labelSetSha256: hashes.labelSetSha256,
      responsesSha256,
      runSha256,
      candidateCommit
    }, publicKeyPem);
  } catch (error) {
    if (requireIndependent) throw error;
    return candidateOnlyEvidence(`external attestation was rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    class: "independent",
    independent: true,
    eligibleForPublicClaim: true,
    attestation: {
      url: safeExternalUrl(attestationUrl),
      sha256: attestationSha256,
      format: HOLDOUT_ATTESTATION_FORMAT,
      verified: true
    }
  };
}

function usage() {
  return [
    "External holdout runner (networked; never uses local manifests)",
    "",
    "Required:",
    "  --manifest-url URL --manifest-sha256 HEX --candidate COMMAND",
    "  or PREMISE_HOLDOUT_MANIFEST_URL, PREMISE_HOLDOUT_MANIFEST_SHA256, PREMISE_HOLDOUT_CANDIDATE",
    "",
    "Optional independent attestation:",
    "  --attestation-url URL --attestation-sha256 HEX --attestation-public-key PEM",
    "  --require-independent  fail closed unless the signed attestation verifies",
    "",
    "No URL/hash means NOT_ELIGIBLE. Contract tests are in contract.test.mjs and never call the network."
  ].join("\n");
}

export async function run(argv = process.argv.slice(2), environment = process.env) {
  if (flag(argv, "--help")) {
    console.log(usage());
    return { status: "HELP" };
  }
  const manifestUrl = optionValue(argv, "--manifest-url", environment.PREMISE_HOLDOUT_MANIFEST_URL);
  const manifestSha256 = optionValue(argv, "--manifest-sha256", environment.PREMISE_HOLDOUT_MANIFEST_SHA256);
  const candidateCommand = optionValue(argv, "--candidate", environment.PREMISE_HOLDOUT_CANDIDATE);
  const outputDir = resolve(optionValue(argv, "--output-dir", environment.PREMISE_HOLDOUT_OUTPUT_DIR ?? ".ga-artifacts/holdout"));
  validateExternalManifestInput({ manifestUrl, manifestSha256, candidateCommand });
  const bearerToken = environment.PREMISE_HOLDOUT_BEARER_TOKEN;
  const manifestDownload = await fetchPinnedBytes(manifestUrl, manifestSha256, "holdout manifest", { bearerToken, maxBytes: 2 * 1024 * 1024 });
  const manifest = validateManifest(parseJsonBytes(manifestDownload.bytes, "holdout manifest"));
  const taskDownload = await fetchPinnedBytes(manifest.dataset.tasks.url, manifest.dataset.tasks.sha256, "holdout task set", { bearerToken, maxBytes: manifest.limits.maxPayloadBytes });
  const taskSet = validateTaskSet(parseJsonBytes(taskDownload.bytes, "holdout task set"), manifest);
  const timeoutMs = Number(optionValue(argv, "--task-timeout-ms", String(manifest.limits.taskTimeoutMs)));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60 * 1000) fail("--task-timeout-ms must be an integer between 1 and 900000");

  // Labels are intentionally fetched only after the candidate has completed. They are never sent to the child process.
  const candidateRun = await runCandidate({ candidateCommand, tasks: taskSet.tasks, manifest, timeoutMs, environment });
  const responsesText = responseJsonl(candidateRun.responses);
  const responsesSha256 = sha256Text(responsesText);
  const labelDownload = await fetchPinnedBytes(manifest.dataset.labels.url, manifest.dataset.labels.sha256, "holdout label set", { bearerToken, maxBytes: manifest.limits.maxPayloadBytes });
  const labelSet = validateLabelSet(parseJsonBytes(labelDownload.bytes, "holdout label set"), taskSet);
  const metrics = summarize(candidateRun.responses, labelSet.labels);
  const eligibility = benchmarkEligibility(metrics, manifest);
  const traces = tracesFor(candidateRun.responses, labelSet.labels);
  const candidateCommit = candidateCommitFromEnvironment(environment);
  const hashes = {
    manifestSha256: manifestDownload.actualSha256,
    taskSetSha256: taskDownload.actualSha256,
    labelSetSha256: labelDownload.actualSha256
  };
  const runFingerprint = {
    format: "premise-ga-holdout-run-fingerprint/1",
    runner: HOLDOUT_RUNNER_VERSION,
    campaignId: manifest.campaign.id,
    ...hashes,
    responsesSha256,
    candidateCommit: candidateCommit ?? null,
    metrics,
    eligibility,
    adapter: candidateRun.adapterCounters
  };
  const runSha256 = sha256Text(stableJson(runFingerprint));
  const evidence = await resolveEvidenceClass({ args: argv, manifest, hashes, responsesSha256, runSha256, candidateCommit, environment });
  if (candidateRun.fatal && evidence.class === "independent") fail("candidate failed before completing the holdout; independent evidence is not possible", "HOLDOUT_NOT_ELIGIBLE");
  if (evidence.class === "independent" && !eligibility.passed) {
    fail("independent holdout evidence did not meet the declared task, accuracy and freshness thresholds", "HOLDOUT_NOT_ELIGIBLE");
  }
  await mkdir(outputDir, { recursive: true });
  const result = {
    schema: "premise-ga-holdout-result/1",
    format: "premise-ga-holdout-result/1",
    runner: HOLDOUT_RUNNER_VERSION,
    commit: candidateCommit ?? null,
    source: {
      adapter: manifest.source.adapter,
      apiBase: safeExternalUrl(manifest.source.apiBase),
      repository: manifest.source.repository,
      readOnly: manifest.source.readOnly
    },
    trace: {
      runSha256,
      responsesSha256,
      manifestSha256: hashes.manifestSha256,
      taskSetSha256: hashes.taskSetSha256,
      labelSetSha256: hashes.labelSetSha256
    },
    status: evidence.class === "independent" ? "INDEPENDENT_EVIDENCE" : "CANDIDATE_EVIDENCE",
    evidence,
    eligibleForPublicClaim: evidence.eligibleForPublicClaim,
    benchmark: {
      campaignId: manifest.campaign.id,
      split: "holdout",
      tasks: taskSet.tasks.length,
      generatedAt: new Date().toISOString(),
      runSha256,
      candidateCommit: candidateCommit ?? null,
      thresholds: manifest.thresholds,
      eligibility
    },
    verification: {
      manifestUrl: safeExternalUrl(manifestUrl),
      taskSetUrl: safeExternalUrl(manifest.dataset.tasks.url),
      labelSetUrl: safeExternalUrl(manifest.dataset.labels.url),
      ...hashes,
      hashAlgorithm: "sha256",
      externalImmutable: true,
      labelsLoadedAfterCandidate: true,
      labelsSentToCandidate: false,
      fixtureEvidenceUsed: false,
      connector: "github-api-read-only",
      writeRequests: candidateRun.adapterCounters.writeRequests
    },
    metrics,
    traces,
    claims: {
      allowed: evidence.class === "independent" ? ["the reported holdout metrics for these exact external hashes, candidate commit, runner, and signed attestation"] : ["candidate-only observations for these exact external hashes; not an independent or public GA claim"],
      forbidden: ["universal product claims", "independent evidence without the verified attestation", "fixture-backed evidence", "provider billing or SLA guarantees"]
    }
  };
  await writeFile(resolve(outputDir, "responses.jsonl"), responsesText, "utf8");
  const resultText = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(resolve(outputDir, "results.json"), resultText, "utf8");
  await writeFile(resolve(outputDir, "external-holdout.json"), resultText, "utf8");
  await writeFile(resolve(outputDir, "provenance.json"), `${JSON.stringify({
    format: "premise-ga-holdout-provenance/1",
    evidenceClass: evidence.class,
    ...hashes,
    responsesSha256,
    runSha256,
    source: { adapter: "github", repository: manifest.source.repository, apiBase: safeExternalUrl(manifest.source.apiBase), readOnly: true, writeRequests: candidateRun.adapterCounters.writeRequests },
    labelsLoadedAfterCandidate: true,
    labelsSentToCandidate: false
  }, null, 2)}\n`, "utf8");
  await writeFile(resolve(outputDir, "dataset-manifest.json"), `${JSON.stringify({
    schema: "premise-ga-holdout-dataset-manifest/1",
    format: "premise-ga-holdout-dataset-manifest/1",
    commit: candidateCommit ?? null,
    generatedAt: result.benchmark.generatedAt,
    source: {
      kind: "external-blind-holdout",
      adapter: manifest.source.adapter,
      apiBase: safeExternalUrl(manifest.source.apiBase),
      repository: manifest.source.repository,
      readOnly: manifest.source.readOnly
    },
    trace: {
      campaignId: manifest.campaign.id,
      manifestSha256: hashes.manifestSha256,
      taskSetSha256: hashes.taskSetSha256,
      labelSetSha256: hashes.labelSetSha256,
      runSha256,
      labelsLoadedAfterCandidate: true,
      labelsSentToCandidate: false
    },
    dataset: {
      split: "holdout",
      tasks: taskSet.tasks.length,
      manifestUrl: safeExternalUrl(manifestUrl),
      taskSetUrl: safeExternalUrl(manifest.dataset.tasks.url),
      labelSetUrl: safeExternalUrl(manifest.dataset.labels.url),
      immutable: true,
      sealedLabels: true
    },
    independent: evidence.independent === true,
    eligibleForPublicClaim: evidence.eligibleForPublicClaim,
    labelsSentToCandidate: false
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: result.status, evidenceClass: evidence.class, eligibleForPublicClaim: result.eligibleForPublicClaim, tasks: result.benchmark.tasks, correctPer100: metrics.correctPer100, errorsPer100: metrics.errorsPer100, outputDir }, null, 2));
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  run().catch((error) => {
    const code = error?.code === "HOLDOUT_NOT_ELIGIBLE" || error instanceof HoldoutContractError && error.code === "HOLDOUT_NOT_ELIGIBLE" ? 2 : 1;
    console.error(JSON.stringify({ status: code === 2 ? "NOT_ELIGIBLE" : "FAIL", evidenceClass: "none", eligibleForPublicClaim: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = code;
  });
}
