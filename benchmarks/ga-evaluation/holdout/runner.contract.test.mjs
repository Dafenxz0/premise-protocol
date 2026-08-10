import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./runner.mjs";
import { sha256Bytes } from "./contract.mjs";

const taskSet = {
  format: "premise-ga-holdout-tasks/1",
  version: "1.0.0",
  tasks: [{ id: "task-001", prompt: "Return the default branch.", source: { id: "source-001", adapter: "github", method: "GET", path: "/repos/acme/public-repo" } }]
};
const labelSet = {
  format: "premise-ga-holdout-labels/1",
  version: "1.0.0",
  labels: [{ taskId: "task-001", answer: "main" }]
};
const taskBytes = Buffer.from(JSON.stringify(taskSet));
const labelBytes = Buffer.from(JSON.stringify(labelSet));
const manifest = {
  format: "premise-ga-holdout-manifest/1",
  version: "1.0.0",
  campaign: { id: "contract-runner-campaign", split: "holdout", kind: "external-blind", publisher: "contract-test", createdAt: "2026-08-10T00:00:00Z" },
  source: { adapter: "github", apiBase: "https://api.github.com", repository: "acme/public-repo", readOnly: true },
  dataset: {
    tasks: { url: "https://evaluator.example.test/holdout/tasks.json", sha256: sha256Bytes(taskBytes), mediaType: "application/json", immutable: true },
    labels: { url: "https://evaluator.example.test/holdout/labels.json", sha256: sha256Bytes(labelBytes), mediaType: "application/json", immutable: true, sealed: true }
  },
  independence: { required: true, labelsSealed: true, separateRunner: true, candidateEvidenceAllowed: true },
  limits: { maxTasks: 10, maxPayloadBytes: 1024 * 1024, taskTimeoutMs: 10_000 }
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const blobs = new Map([
  ["https://evaluator.example.test/holdout/manifest.json", manifestBytes],
  ["https://evaluator.example.test/holdout/tasks.json", taskBytes],
  ["https://evaluator.example.test/holdout/labels.json", labelBytes]
]);
const fetchCalls = [];
const originalFetch = globalThis.fetch;
const responseFor = (url, bytes) => ({
  ok: true,
  status: 200,
  url,
  headers: { get: () => null },
  async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
  async text() { return "{}"; }
});
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const bytes = blobs.get(String(url));
  if (!bytes) throw new Error(`unexpected network request in deterministic runner test: ${url}`);
  return responseFor(String(url), bytes);
};

const outputDir = await mkdtemp(join(tmpdir(), "premise-holdout-contract-"));
const candidatePath = join(outputDir, "candidate.mjs");
await writeFile(candidatePath, "import { createInterface } from 'node:readline'; const rl = createInterface({ input: process.stdin }); rl.on('line', (line) => { const message = JSON.parse(line); if (message.type === 'task') { const leaked = process.env.PREMISE_HOLDOUT_BEARER_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN; process.stdout.write(JSON.stringify({ type: 'answer', answer: leaked || 'main' }) + '\\n'); } });\n", "utf8");
const candidateCommand = `"${process.execPath}" "${candidatePath}"`;
try {
  const result = await run([
    "--manifest-url", "https://evaluator.example.test/holdout/manifest.json",
    "--manifest-sha256", sha256Bytes(manifestBytes),
    "--candidate", candidateCommand,
    "--output-dir", outputDir
  ], { PATH: process.env.PATH, PREMIISE_UNUSED: "ignored", PREMISE_HOLDOUT_BEARER_TOKEN: "test-token-must-not-leak", GITHUB_TOKEN: "test-github-token-must-not-leak" });
  assert.equal(result.status, "CANDIDATE_EVIDENCE");
  assert.equal(result.evidence.class, "candidate");
  assert.equal(result.eligibleForPublicClaim, false);
  assert.equal(result.verification.labelsLoadedAfterCandidate, true);
  assert.equal(result.verification.labelsSentToCandidate, false);
  assert.equal(result.verification.writeRequests, 0);
  assert.equal(result.metrics.correctPer100, 100);
  assert.deepEqual(fetchCalls, [
    "https://evaluator.example.test/holdout/manifest.json",
    "https://evaluator.example.test/holdout/tasks.json",
    "https://evaluator.example.test/holdout/labels.json"
  ]);
  const responses = await readFile(join(outputDir, "responses.jsonl"), "utf8");
  assert.ok(!responses.includes("sourceVersion"));
  assert.ok(!responses.includes("labels-2026"));
  const serializedResult = await readFile(join(outputDir, "results.json"), "utf8");
  assert.ok(serializedResult.includes("CANDIDATE_EVIDENCE"));
  assert.equal(JSON.parse(await readFile(join(outputDir, "external-holdout.json"), "utf8")).status, "CANDIDATE_EVIDENCE");
  const datasetEvidence = JSON.parse(await readFile(join(outputDir, "dataset-manifest.json"), "utf8"));
  assert.equal(datasetEvidence.labelsSentToCandidate, false);
  assert.equal(Object.hasOwn(datasetEvidence, "labels"), false);
  console.log(JSON.stringify({ status: "PASS", testType: "holdout-runner-contract", externalNetworkCalls: 0, labelsFetchedAfterCandidate: true, evidenceClass: result.evidence.class }));
} finally {
  globalThis.fetch = originalFetch;
  await rm(outputDir, { recursive: true, force: true });
}
