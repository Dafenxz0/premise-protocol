import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

try {
  await import("node:sqlite");
} catch {
  console.log("store-sqlite v2 runtime tests skipped: this Node runtime does not provide node:sqlite");
  process.exit(0);
}

const { PremiseRuntime } = await import("@premise/runtime-core");
const { SqliteRuntimeStore } = await import("../dist/index.js");

const at = "2026-08-10T10:00:00Z";
const envelope = {
  specVersion: "premise/2",
  tenantId: "tenant:sqlite",
  memoryId: "memory:sqlite:v2",
  evidence: [{ evidenceId: "e:sqlite", sourceUri: "file:///sqlite", observedAt: at }],
  confidence: { score: null, method: "test", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
  dependsOn: [],
  signatures: []
};

const directory = mkdtempSync(path.join(tmpdir(), "premise-runtime-sqlite-"));
const filename = path.join(directory, "runtime.sqlite");
try {
  const firstStore = new SqliteRuntimeStore(filename);
  const first = new PremiseRuntime({ store: firstStore, tenantId: "tenant:sqlite", now: () => at });
  first.register({ envelope, content: { answer: 42 } });
  assert.equal(first.history().length, 1);
  firstStore.close();

  const secondStore = new SqliteRuntimeStore(filename);
  const second = new PremiseRuntime({ store: secondStore, tenantId: "tenant:sqlite", now: () => at });
  assert.deepEqual(second.get(envelope.memoryId).content, { answer: 42 });
  assert.equal(second.history(envelope.memoryId).length, 1);
  const snapshot = second.snapshot();
  second.restore(snapshot);
  assert.equal(second.store.list().length, 1);
  secondStore.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("store-sqlite v2 runtime tests passed");
