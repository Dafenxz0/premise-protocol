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

class CountingSqliteRuntimeStore extends SqliteRuntimeStore {
  getCalls = 0;
  getManyCalls = 0;

  get(memoryId) {
    this.getCalls += 1;
    return super.get(memoryId);
  }

  getMany(memoryIds) {
    this.getManyCalls += 1;
    return super.getMany(memoryIds);
  }
}

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

  const secondStore = new CountingSqliteRuntimeStore(filename);
  const second = new PremiseRuntime({ store: secondStore, tenantId: "tenant:sqlite", now: () => at });
  assert.deepEqual(second.get(envelope.memoryId).content, { answer: 42 });
  secondStore.getCalls = 0;
  secondStore.getManyCalls = 0;
  assert.deepEqual(secondStore.getMany([envelope.memoryId, envelope.memoryId, "memory:missing"]).map(({ envelope: loaded }) => loaded.memoryId), [envelope.memoryId]);
  secondStore.getCalls = 0;
  secondStore.getManyCalls = 0;
  assert.deepEqual(second.checkMany([envelope.memoryId, "memory:missing", envelope.memoryId]).map((item) => item.memoryId), [envelope.memoryId, "memory:missing", envelope.memoryId]);
  assert.equal(secondStore.getManyCalls, 1, "SQLite runtime reads must use one SQL batch");
  assert.equal(secondStore.getCalls, 0, "SQLite runtime must not issue per-ID reads when getMany exists");
  assert.equal(second.history(envelope.memoryId).length, 1);
  const snapshot = second.snapshot();
  second.restore(snapshot);
  assert.equal(second.store.list().length, 1);
  secondStore.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("store-sqlite v2 runtime tests passed");
