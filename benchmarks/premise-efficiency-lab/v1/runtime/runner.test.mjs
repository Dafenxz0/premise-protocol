import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeInstrumentationRecorder } from "../../../../packages/runtime-core/dist/index.js";
import {
  DeterministicMutableSourceAdapter,
  PHYSICAL_COUNTER_SCHEMA,
  PHYSICAL_TRACE_FORMAT,
  runPhysicalTask
} from "./runner.mjs";

const at = "2026-08-13T12:00:00.000Z";

test("the physical runner executes built runtime-core and returns deterministic counters and decisions", async () => {
  const options = {
    taskId: "task-physical-chain",
    candidateId: "blind-runtime-core",
    commit: "sha256:test-commit",
    now: at,
    nodes: [
      { id: "memory:a", sourceUri: "source://a", content: { value: "a" } },
      { id: "memory:b", dependsOn: ["memory:a"], content: { value: "b" } },
      { id: "memory:c", dependsOn: ["memory:b"], content: { value: "c" } }
    ],
    targetIds: ["memory:c"],
    mutation: { nodeId: "memory:a", token: "v2", value: { value: "a2" } }
  };
  const first = await runPhysicalTask(options);
  const second = await runPhysicalTask(options);

  assert.deepEqual(first, second);
  assert.equal(first.format, PHYSICAL_TRACE_FORMAT);
  assert.equal(first.counterSchema, PHYSICAL_COUNTER_SCHEMA);
  assert.equal(first.status, "COMPLETE");
  assert.equal(first.counters.sourceReads, 1);
  assert.equal(first.counters.conditionalReads, 1);
  assert.ok(first.counters.nodesVisited > 0);
  assert.ok(first.counters.edgesTraversed > 0);
  assert.ok(first.counters.frontierRecomputes > 0);
  assert.ok(first.counters.decisions > 0);
  assert.ok(first.decisions.some((event) => event.memoryId === "memory:a" && event.decision === "REJECT"));
  assert.ok(first.decisions.some((event) => event.memoryId === "memory:c" && event.decision === "REVALIDATE"));
});

test("the mutable source adapter makes versioned reads physical and deterministic", () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const adapter = new DeterministicMutableSourceAdapter({ now: () => at, instrumentation: recorder });
  adapter.register("source://mutable", { value: { version: 1 } });
  const record = { envelope: { memoryId: "memory:mutable" } };
  const first = adapter.read({
    evidenceId: "evidence:mutable",
    sourceUri: "source://mutable",
    version: { scheme: "deterministic.source", token: "v1" }
  }, record);
  assert.equal(first.result, "UNCHANGED");

  const change = adapter.mutate("source://mutable", { value: { version: 2 } });
  const second = adapter.read({
    evidenceId: "evidence:mutable",
    sourceUri: "source://mutable",
    version: { scheme: "deterministic.source", token: "v1" }
  }, record);
  assert.deepEqual(change.version, { scheme: "deterministic.source", token: "v2" });
  assert.equal(second.result, "CHANGED");
  assert.equal(recorder.snapshot().sourceReads, 2);
  assert.equal(recorder.snapshot().conditionalReads, 2);
  assert.equal(adapter.current("source://mutable").value.version, 2);
});

test("multiple source mutations use runtime-core batch invalidation and retain physical read counts", async () => {
  const trace = await runPhysicalTask({
    now: at,
    nodes: [
      { id: "memory:a", sourceUri: "source://a" },
      { id: "memory:b", sourceUri: "source://b" }
    ],
    targetIds: ["memory:a", "memory:b"],
    mutations: [
      { sourceUri: "source://a", token: "v2" },
      { sourceUri: "source://b", token: "v2" }
    ]
  });

  assert.equal(trace.counters.batchCount, 1);
  assert.equal(trace.counters.batchItems, 2);
  assert.equal(trace.counters.sourceReads, 2);
  assert.equal(trace.counters.conditionalReads, 2);
  assert.ok(trace.counters.eventContinuityChecks >= 2);
  assert.equal(trace.decisions.filter((event) => event.decision === "REJECT").length, 4);
});

test("the action guard does not accept an ABA token from another version scheme", async () => {
  const trace = await runPhysicalTask({
    taskId: "task-aba-scheme",
    nodes: [{
      id: "memory:aba",
      sourceUri: "deterministic://aba",
      evidence: [{
        sourceUri: "deterministic://aba",
        version: { scheme: "source.incarnation-a", token: "same-token" }
      }]
    }],
    sources: {
      "deterministic://aba": { version: { scheme: "source.incarnation-b", token: "same-token" } }
    },
    mutations: null,
    targetIds: ["memory:aba"],
    performAction: true,
    action: { kind: "conditional-update" }
  });
  assert.equal(trace.action.accepted, false);
  assert.equal(trace.action.reason, "REJECT");
});
