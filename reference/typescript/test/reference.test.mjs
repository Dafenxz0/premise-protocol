import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runVector, runVectors } from "../dist/index.js";

const vectorPath = fileURLToPath(new URL("../vectors/basic.json", import.meta.url));
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("checks fresh evidence, stale dependencies and conservative decisions", () => {
  const fresh = runVector({
    id: "fresh",
    operation: "check",
    tenant: "team-a",
    memory: { memoryId: "source", tenantId: "team-a", evidence: [{ source: "config", version: "v1" }], dependencies: [], invalidation: null },
    observations: { config: { available: true, version: "v1" } },
    target: "source"
  });
  assert.deepEqual(fresh.output, { state: "FRESH", decision: "USE" });

  const stale = runVector({
    id: "stale",
    operation: "check",
    tenant: "team-a",
    memories: [
      { memoryId: "source", tenantId: "team-a", evidence: [{ source: "config", version: "v1" }], dependencies: [], invalidation: null },
      { memoryId: "derived", tenantId: "team-a", evidence: [], dependencies: ["source"], invalidation: null }
    ],
    observations: { config: { available: true, version: "v2" } },
    target: "derived"
  });
  assert.deepEqual(stale.output, { state: "STALE", decision: "REVALIDATE" });
});

test("implements invalidation, tenant isolation, revalidation, replay and TOCTOU", () => {
  assert.deepEqual(runVector({ id: "invalid", operation: "check", tenant: "a", memory: { memoryId: "m", tenantId: "a", evidence: [], dependencies: [], invalidation: { reason: "gone" } }, target: "m" }).output, { state: "INVALID", decision: "REJECT" });
  assert.deepEqual(runVector({ id: "private", operation: "check", tenant: "b", memory: { memoryId: "m", tenantId: "a", evidence: [], dependencies: [], invalidation: null }, target: "m" }).output, { state: "UNKNOWN", decision: "REJECT" });
  assert.deepEqual(runVector({ id: "revalidate", operation: "revalidate", results: [{ result: "UNCHANGED" }, { result: "MISSING" }, { result: "UNKNOWN" }] }).output, [
    { state: "FRESH", decision: "USE" },
    { state: "INVALID", decision: "REJECT" },
    { state: "UNKNOWN", decision: "REJECT" }
  ]);
  assert.deepEqual(runVector({ id: "replay", operation: "replay", operations: [
    { idempotencyKey: "k", payload: { b: 2, a: 1 } },
    { idempotencyKey: "k", payload: { a: 1, b: 2 } },
    { idempotencyKey: "k", payload: { a: 9 } }
  ] }).output, { applied: 1, replayed: 1, conflicts: 1 });
  assert.deepEqual(runVector({ id: "write", operation: "write", validatedVersion: "v1", writeVersion: "v2" }).output, { state: "STALE", decision: "REVALIDATE", toctouEscaped: false });
});

test("executes the JSON vectors and CLI deterministically", () => {
  const document = JSON.parse(readFileSync(vectorPath, "utf8"));
  assert.equal(runVectors(document).length, 4);
  const output = execFileSync(process.execPath, [cliPath, vectorPath], { encoding: "utf8" });
  const repeat = execFileSync(process.execPath, [cliPath, vectorPath], { encoding: "utf8" });
  assert.equal(output, repeat);
  assert.deepEqual(JSON.parse(output)[0].output, { state: "FRESH", decision: "USE" });
});
