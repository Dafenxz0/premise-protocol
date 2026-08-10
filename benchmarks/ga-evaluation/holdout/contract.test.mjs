import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  HOLDOUT_ATTESTATION_FORMAT,
  HOLDOUT_MANIFEST_FORMAT,
  HOLDOUT_LABELS_FORMAT,
  HOLDOUT_TASKS_FORMAT,
  HoldoutContractError,
  answerDigest,
  answersEqual,
  assertExternalUrl,
  assertSha256,
  publicTask,
  sha256Text,
  stableJson,
  validateExternalManifestInput,
  validateLabelSet,
  validateManifest,
  validateTaskSet,
  verifyIndependentAttestation
} from "./contract.mjs";

function assertThrows(action, pattern) {
  assert.throws(action, (error) => error instanceof HoldoutContractError && pattern.test(error.message));
}

const taskUrl = "https://evaluator.example.test/holdout/tasks-2026-08-10.json";
const labelUrl = "https://evaluator.example.test/holdout/labels-2026-08-10.json";
const taskSet = {
  format: HOLDOUT_TASKS_FORMAT,
  version: "1.0.0",
  tasks: [
    { id: "task-001", prompt: "What is the default branch?", source: { id: "source-001", adapter: "github", method: "GET", path: "/repos/acme/public-repo" } },
    { id: "task-002", prompt: "Read the repository README metadata.", source: { id: "source-002", adapter: "github", method: "GET", path: "/repos/acme/public-repo/readme" } }
  ]
};
const labelSet = {
  format: HOLDOUT_LABELS_FORMAT,
  version: "1.0.0",
  labels: [
    { taskId: "task-001", answer: "main", sourceVersion: "etag-1" },
    { taskId: "task-002", answer: { encoding: "base64" } }
  ]
};
const manifest = {
  format: HOLDOUT_MANIFEST_FORMAT,
  version: "1.0.0",
  campaign: { id: "campaign-2026-08-10", split: "holdout", kind: "external-blind", publisher: "independent-evaluator", createdAt: "2026-08-10T00:00:00Z" },
  source: { adapter: "github", apiBase: "https://api.github.com", repository: "acme/public-repo", readOnly: true },
  dataset: {
    tasks: { url: taskUrl, sha256: "1111111111111111111111111111111111111111111111111111111111111111", mediaType: "application/json", immutable: true },
    labels: { url: labelUrl, sha256: "2222222222222222222222222222222222222222222222222222222222222222", mediaType: "application/json", immutable: true, sealed: true }
  },
  independence: { required: true, labelsSealed: true, separateRunner: true, candidateEvidenceAllowed: true },
  limits: { maxTasks: 100, maxPayloadBytes: 1024 * 1024, taskTimeoutMs: 10_000 }
};

const validatedManifest = validateManifest(manifest);
const validatedTasks = validateTaskSet(taskSet, validatedManifest);
const validatedLabels = validateLabelSet(labelSet, validatedTasks);
assert.equal(validatedTasks.tasks.length, 2);
assert.equal(validatedLabels.labels.get("task-001").answer, "main");
assert.equal(publicTask(validatedTasks.tasks[0]).protocol, "premise-ga-holdout/1");
assert.ok(!JSON.stringify(publicTask(validatedTasks.tasks[0])).includes("answer"));

assert.equal(stableJson({ b: 2, a: 1 }), "{\"a\":1,\"b\":2}");
assert.equal(sha256Text("PREMiSE"), "c7ca2964c4b9797e8793e89ec02fa8a645f93a6def933772a5f4194a7f3150de");
assert.equal(answerDigest({ a: 1, b: 2 }), answerDigest({ b: 2, a: 1 }));
assert.ok(answersEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
assert.notEqual(answerDigest("main"), answerDigest("develop"));

assertExternalUrl(taskUrl);
assertSha256(manifest.dataset.tasks.sha256);
assertThrows(() => assertExternalUrl("file:///tmp/tasks.json"), /local or fixture scheme/u);
assertThrows(() => assertExternalUrl("https://fixture.example.test/tasks.json"), /local or fixture scheme/u);
assertThrows(() => assertExternalUrl("http://evaluator.example.test/tasks.json"), /must use https/u);
assertThrows(() => assertExternalUrl("https://127.0.0.1/tasks.json"), /local or private host/u);
assertThrows(() => validateTaskSet({ ...taskSet, tasks: [{ ...taskSet.tasks[0], answer: "main" }] }, validatedManifest), /answer-key field/u);
assertThrows(() => validateTaskSet({ ...taskSet, tasks: [{ ...taskSet.tasks[0], source: { ...taskSet.tasks[0].source, method: "POST" } }] }, validatedManifest), /must be GET/u);
assertThrows(() => validateLabelSet({ ...labelSet, labels: [{ taskId: "task-001", answer: "main" }, { taskId: "task-001", answer: "duplicate" }] }, validatedTasks), /duplicate label/u);
assertThrows(() => validateManifest({ ...manifest, dataset: { ...manifest.dataset, labels: { ...manifest.dataset.labels, url: taskUrl } } }), /different/u);
assertThrows(() => validateExternalManifestInput({ manifestUrl: undefined, manifestSha256: undefined, candidateCommand: "node candidate.mjs" }), /MANIFEST_URL/u);
assertThrows(() => validateExternalManifestInput({ manifestUrl: taskUrl, manifestSha256: "not-a-sha", candidateCommand: "node candidate.mjs" }), /SHA-256/u);

const attestationExpected = {
  manifestSha256: "a".repeat(64),
  taskSetSha256: "b".repeat(64),
  labelSetSha256: "c".repeat(64),
  responsesSha256: "d".repeat(64),
  runSha256: "e".repeat(64),
  candidateCommit: "f".repeat(40)
};
const attestationPayload = {
  format: HOLDOUT_ATTESTATION_FORMAT,
  status: "independent",
  ...attestationExpected,
  independentRunnerId: "independent-runner",
  evaluatorId: "independent-evaluator",
  labelsAccessedAfterResponses: true,
  sourceReadOnly: true,
  fixturesUsed: false
};
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const signature = sign(null, Buffer.from(stableJson(attestationPayload), "utf8"), privateKey).toString("base64");
assert.deepEqual(verifyIndependentAttestation({ ...attestationPayload, signature }, attestationExpected, publicKey.export({ type: "spki", format: "pem" })), { verified: true, evaluatorId: "independent-evaluator", independentRunnerId: "independent-runner" });
assertThrows(() => verifyIndependentAttestation({ ...attestationPayload, signature: "invalid" }, attestationExpected, publicKey.export({ type: "spki", format: "pem" })), /signature is invalid/u);

console.log(JSON.stringify({ status: "PASS", testType: "holdout-contract", networkCalls: 0, externalEvidenceProduced: false, tasksValidated: validatedTasks.tasks.length }));
