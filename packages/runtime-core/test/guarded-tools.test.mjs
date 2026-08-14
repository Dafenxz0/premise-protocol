import test from "node:test";
import assert from "node:assert/strict";
import { BoundedGuardedToolIdempotencyStore, createGuardedTool } from "../dist/index.js";

const resource = { tenantId: "tenant:acme", resource: "github://acme/repo/pull/42" };
const v1 = { scheme: "github.commit", token: "a1" };
const v2 = { scheme: "github.commit", token: "b2" };

function freshCallbacks(overrides = {}) {
  return {
    check: async (input) => ({ ...input, state: "FRESH", version: v1 }),
    revalidate: async (input) => ({ ...input, outcome: "FRESH", observedVersion: input.expectedVersion }),
    act: async (input) => ({ ...input, outcome: "APPLIED", result: { action: input.action } }),
    ...overrides
  };
}

test("requires explicit check, revalidate and act with tenant/resource/version", async () => {
  const calls = [];
  const tool = createGuardedTool({ callbacks: freshCallbacks({
    check: async (input) => { calls.push(["check", input]); return { ...input, state: "FRESH", version: v1 }; },
    revalidate: async (input) => { calls.push(["revalidate", input]); return { ...input, outcome: "FRESH", observedVersion: v1 }; },
    act: async (input) => { calls.push(["act", input]); return { ...input, outcome: "APPLIED", result: "done" }; }
  }) });
  const checked = await tool.check(resource);
  const ready = await tool.revalidate(checked);
  assert.equal(ready.ready, true);
  const result = await tool.act(ready, { operation: "merge" }, "idem:1");
  assert.equal(result.accepted, true);
  assert.deepEqual(calls.map(([name]) => name), ["check", "revalidate", "act"]);
  assert.deepEqual(calls[1][1], { ...resource, expectedVersion: v1 });
  assert.deepEqual(calls[2][1], { ...resource, expectedVersion: v1, idempotencyKey: "idem:1", action: { operation: "merge" }, signal: calls[2][1].signal });
  assert.equal(calls[2][1].signal instanceof AbortSignal, true);
});

test("stale evidence can recover, while missing and unknown fail closed", async () => {
  let acts = 0;
  const tool = createGuardedTool({ callbacks: freshCallbacks({
    check: async (input) => ({ ...input, state: input.resource.endsWith("stale") ? "STALE" : input.resource.endsWith("missing") ? "MISSING" : "UNKNOWN", ...(input.resource.endsWith("stale") ? { version: v1 } : {}) }),
    revalidate: async (input) => ({ ...input, outcome: "FRESH", observedVersion: v2 }),
    act: async (input) => { acts += 1; return { ...input, outcome: "APPLIED" }; }
  }) });
  const recoveredCheck = await tool.check({ ...resource, resource: `${resource.resource}/stale` });
  const recovered = await tool.revalidate(recoveredCheck);
  assert.deepEqual(recovered, { ready: true, ...resource, resource: `${resource.resource}/stale`, version: v2 });
  assert.equal((await tool.act(recovered, "repair", "idem:stale")).accepted, true);

  const missingCheck = await tool.check({ ...resource, resource: `${resource.resource}/missing` });
  assert.deepEqual(await tool.revalidate(missingCheck), {
    ready: false, tenantId: resource.tenantId, resource: `${resource.resource}/missing`, outcome: "MISSING", reason: "MISSING_RESOURCE"
  });
  const unknownCheck = await tool.check({ ...resource, resource: `${resource.resource}/unknown` });
  assert.deepEqual(await tool.revalidate(unknownCheck), {
    ready: false, tenantId: resource.tenantId, resource: `${resource.resource}/unknown`, outcome: "UNKNOWN", reason: "UNKNOWN_CHECK"
  });
  assert.equal(acts, 1);
});

test("version mismatch never reaches the side effect", async () => {
  let acts = 0;
  const tool = createGuardedTool({ callbacks: freshCallbacks({
    revalidate: async (input) => ({ ...input, outcome: "VERSION_MISMATCH", observedVersion: v2 }),
    act: async (input) => { acts += 1; return { ...input, outcome: "APPLIED" }; }
  }) });
  const checked = await tool.check(resource);
  const mismatch = await tool.revalidate(checked);
  assert.deepEqual(mismatch, { ready: false, ...resource, outcome: "VERSION_MISMATCH", observedVersion: v2, reason: "VERSION_MISMATCH" });
  assert.equal(acts, 0);
});

test("idempotency executes one side effect and rejects key reuse with different input", async () => {
  let acts = 0;
  const tool = createGuardedTool({ callbacks: freshCallbacks({
    act: async (input) => { acts += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { ...input, outcome: "APPLIED", result: acts }; }
  }) });
  const ready = await tool.revalidate(await tool.check(resource));
  const [first, second] = await Promise.all([tool.act(ready, "same", "idem:one"), tool.act(ready, "same", "idem:one")]);
  assert.deepEqual(first, second);
  assert.equal(acts, 1);
  assert.deepEqual(await tool.act(ready, "different", "idem:one"), {
    accepted: false, outcome: "REJECTED", ...resource, expectedVersion: v1, reason: "IDEMPOTENCY_CONFLICT"
  });
  assert.equal(acts, 1);
});

test("concurrent reuse with a different fingerprint returns a conflict", async () => {
  let acts = 0;
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const tool = createGuardedTool({ callbacks: freshCallbacks({
    act: async (input) => {
      acts += 1;
      markStarted();
      await blocked;
      return { ...input, outcome: "APPLIED", result: input.action };
    }
  }) });
  const ready = await tool.revalidate(await tool.check(resource));
  const first = tool.act(ready, { operation: "merge" }, "idem:concurrent");
  await started;

  assert.deepEqual(await tool.act(ready, { operation: "delete" }, "idem:concurrent"), {
    accepted: false, outcome: "REJECTED", ...resource, expectedVersion: v1, reason: "IDEMPOTENCY_CONFLICT"
  });
  assert.equal(acts, 1);

  release();
  assert.deepEqual((await first).result, { operation: "merge" });
  assert.equal(acts, 1);
});

test("side-effect timeout and thrown unknown are terminal, cached outcomes", async () => {
  let timedOutCalls = 0;
  const timedOut = createGuardedTool({
    sideEffectTimeoutMs: 10,
    callbacks: freshCallbacks({ act: async () => { timedOutCalls += 1; await new Promise(() => {}); return { ...resource, outcome: "APPLIED" }; } })
  });
  const timedReady = await timedOut.revalidate(await timedOut.check(resource));
  const timeoutResult = await timedOut.act(timedReady, "dangerous", "idem:timeout");
  assert.deepEqual(timeoutResult, { accepted: false, outcome: "UNKNOWN", ...resource, expectedVersion: v1, reason: "SIDE_EFFECT_TIMEOUT" });
  assert.deepEqual(await timedOut.act(timedReady, "dangerous", "idem:timeout"), timeoutResult);
  assert.equal(timedOutCalls, 1);

  const unknown = createGuardedTool({ callbacks: freshCallbacks({ act: async () => { throw new Error("transport lost"); } }) });
  const unknownReady = await unknown.revalidate(await unknown.check(resource));
  assert.deepEqual(await unknown.act(unknownReady, "dangerous", "idem:unknown"), {
    accepted: false, outcome: "UNKNOWN", ...resource, expectedVersion: v1, reason: "SIDE_EFFECT_UNKNOWN"
  });
});

test("callback failures and forged phase values cannot open a mutation path", async () => {
  let acts = 0;
  const tool = createGuardedTool({ callbacks: freshCallbacks({
    check: async () => { throw new Error("check unavailable"); },
    act: async (input) => { acts += 1; return { ...input, outcome: "APPLIED" }; }
  }) });
  const unknown = await tool.check(resource);
  assert.equal(unknown.state, "UNKNOWN");
  assert.equal((await tool.revalidate(unknown)).ready, false);
  assert.equal((await tool.act({ ready: true, ...resource, version: v1 }, "forged", "idem:forged")).accepted, false);
  assert.equal(acts, 0);
});

test("bounded idempotency never evicts accepted side effects", async () => {
  const store = new BoundedGuardedToolIdempotencyStore({ maxEntries: 1 });
  const first = store.claim("tenant:acme\\u0000one", "fingerprint:one");
  assert.deepEqual(first, { kind: "NEW" });
  store.complete("tenant:acme\\u0000one", "fingerprint:one", { accepted: true, outcome: "APPLIED", tenantId: "tenant:acme", resource: "resource:one", result: "done" });
  assert.deepEqual(store.claim("tenant:acme\\u0000one", "fingerprint:one"), {
    kind: "COMPLETED", result: { accepted: true, outcome: "APPLIED", tenantId: "tenant:acme", resource: "resource:one", result: "done" }
  });
  assert.deepEqual(store.claim("tenant:acme\\u0000two", "fingerprint:two"), { kind: "FULL" });
});

test("GuardedTool reports retention exhaustion instead of forgetting replay history", async () => {
  let acts = 0;
  const tool = createGuardedTool({
    idempotencyStore: new BoundedGuardedToolIdempotencyStore({ maxEntries: 1 }),
    callbacks: freshCallbacks({ act: async (input) => { acts += 1; return { ...input, outcome: "APPLIED", result: acts }; } })
  });
  const ready = await tool.revalidate(await tool.check(resource));
  assert.equal((await tool.act(ready, "one", "idem:one")).accepted, true);
  assert.deepEqual(await tool.act(ready, "two", "idem:two"), {
    accepted: false, outcome: "REJECTED", ...resource, expectedVersion: v1, reason: "IDEMPOTENCY_RETENTION_FULL"
  });
  assert.equal(acts, 1);
  assert.deepEqual(await tool.act(ready, "one", "idem:one"), {
    accepted: true, outcome: "APPLIED", ...resource, expectedVersion: v1, result: 1
  });
});
