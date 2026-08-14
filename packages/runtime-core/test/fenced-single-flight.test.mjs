import test from "node:test";
import assert from "node:assert/strict";
import { FencedSingleFlightCoordinator } from "../dist/fenced-single-flight.js";

const version = (token) => ({ scheme: "test", token });
const validationScope = (tenantId, resource, token, extra = {}) => ({
  tenantId,
  resourceId: resource,
  incarnationId: `inc:${resource}`,
  versionScheme: "test",
  versionToken: token,
  validatorId: "validator:test",
  authorizationContextDigest: "auth:test",
  policyDigest: "policy:test",
  queryDigest: "query:test",
  scopes: ["read:test"],
  changeSetDigest: null,
  causalFrontier: [],
  ...extra
});
const request = (tenantId, resource, token, extra = {}) => ({
  tenantId,
  resource,
  expectedVersion: version(token),
  scope: validationScope(tenantId, resource, token),
  ...extra
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeTimers() {
  const pending = new Set();
  return {
    timers: {
      setTimeout(callback, delayMs) {
        const entry = { callback, delayMs };
        pending.add(entry);
        return entry;
      },
      clearTimeout(entry) {
        pending.delete(entry);
      }
    },
    fireNext() {
      const entry = pending.values().next().value;
      assert.ok(entry, "expected a pending timer");
      pending.delete(entry);
      entry.callback();
    },
    size() {
      return pending.size;
    }
  };
}

test("coalesces the exact tenant/resource/version and shares one promise", async () => {
  const gate = deferred();
  let calls = 0;
  const coordinator = new FencedSingleFlightCoordinator({
    validate: async (input) => {
      calls += 1;
      await gate.promise;
      return { result: "UNCHANGED", fencingToken: input.fencingToken, value: "ok" };
    }
  });
  const first = coordinator.validate(request("tenant:a", "repo", "v1"));
  const second = coordinator.validate(request("tenant:a", "repo", "v1"));
  assert.strictEqual(first, second);
  gate.resolve();
  assert.deepEqual(await first, { result: "UNCHANGED", fencingToken: 1, value: "ok" });
  assert.equal(calls, 1);
});

test("propagates ordinary source errors to all coalesced callers", async () => {
  const error = new Error("connector failed");
  let calls = 0;
  const coordinator = new FencedSingleFlightCoordinator({
    validate: async () => {
      calls += 1;
      throw error;
    }
  });
  const first = coordinator.validate(request("tenant:a", "repo", "v1"));
  const second = coordinator.validate(request("tenant:a", "repo", "v1"));
  await assert.rejects(first, (actual) => actual === error);
  await assert.rejects(second, (actual) => actual === error);
  assert.equal(calls, 1);
});

test("turns an injected timeout into UNKNOWN and never retries the source", async () => {
  const timers = fakeTimers();
  const gate = deferred();
  let calls = 0;
  const coordinator = new FencedSingleFlightCoordinator({
    validate: async () => {
      calls += 1;
      await gate.promise;
      return { result: "UNCHANGED", fencingToken: 1 };
    }
  }, { timers: timers.timers });
  const pending = coordinator.validate(request("tenant:a", "repo", "v1", { timeoutMs: 50 }));
  await Promise.resolve();
  assert.equal(timers.size(), 1);
  timers.fireNext();
  assert.deepEqual(await pending, { result: "UNKNOWN", fencingToken: 1, reason: "TIMEOUT" });
  gate.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
});

test("turns caller abort and source AbortError into UNKNOWN without retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const coordinator = new FencedSingleFlightCoordinator({
    validate: async ({ signal, fencingToken }) => {
      calls += 1;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { result: "UNCHANGED", fencingToken };
    }
  });
  const pending = coordinator.validate(request("tenant:a", "repo", "v1", { signal: controller.signal }));
  await Promise.resolve();
  controller.abort();
  assert.deepEqual(await pending, { result: "UNKNOWN", fencingToken: 1, reason: "ABORTED" });
  assert.equal(calls, 1);

  const sourceAbort = new FencedSingleFlightCoordinator({
    validate: async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }
  });
  assert.deepEqual(await sourceAbort.validate(request("tenant:a", "repo", "v1")), { result: "UNKNOWN", fencingToken: 1, reason: "ABORTED" });
});

test("fences the old validation across a version change and ABA", async () => {
  const gates = [];
  const coordinator = new FencedSingleFlightCoordinator({
    validate: async ({ expectedVersion, fencingToken }) => {
      const gate = deferred();
      gates.push({ token: expectedVersion.token, gate });
      await gate.promise;
      return { result: "UNCHANGED", fencingToken, version: expectedVersion };
    }
  });
  const firstA = coordinator.validate(request("tenant:a", "repo", "A"));
  const b = coordinator.validate(request("tenant:a", "repo", "B"));
  await Promise.resolve();
  gates[0].gate.resolve();
  const firstResult = await firstA;
  await Promise.resolve();
  const secondA = coordinator.validate(request("tenant:a", "repo", "A"));
  await Promise.resolve();
  gates[1].gate.resolve();
  gates[2].gate.resolve();
  const bResult = await b;
  const secondResult = await secondA;
  assert.deepEqual(firstResult, { result: "UNKNOWN", fencingToken: 1, reason: "FENCED" });
  assert.deepEqual(bResult, { result: "UNKNOWN", fencingToken: 2, reason: "FENCED" });
  assert.deepEqual(secondResult, { result: "UNCHANGED", fencingToken: 3, version: version("A") });
});

test("rejects a source result carrying an old fencing token", async () => {
  const coordinator = new FencedSingleFlightCoordinator({
    validate: async () => ({ result: "UNCHANGED", fencingToken: 99, value: "stale" })
  });
  assert.deepEqual(await coordinator.validate(request("tenant:a", "repo", "v1")), { result: "UNKNOWN", fencingToken: 1, reason: "FENCED" });
});

test("never shares a promise or fencing token between tenants", async () => {
  const gates = { a: deferred(), b: deferred() };
  const seen = [];
  const coordinator = new FencedSingleFlightCoordinator({
    validate: async ({ tenantId, fencingToken }) => {
      seen.push({ tenantId, fencingToken });
      await gates[tenantId === "tenant:a" ? "a" : "b"].promise;
      return { result: "UNCHANGED", fencingToken };
    }
  });
  const a = coordinator.validate(request("tenant:a", "repo", "v1"));
  const b = coordinator.validate(request("tenant:b", "repo", "v1"));
  assert.notStrictEqual(a, b);
  gates.a.resolve();
  gates.b.resolve();
  assert.deepEqual(await a, { result: "UNCHANGED", fencingToken: 1 });
  assert.deepEqual(await b, { result: "UNCHANGED", fencingToken: 2 });
  assert.deepEqual(seen, [
    { tenantId: "tenant:a", fencingToken: 1 },
    { tenantId: "tenant:b", fencingToken: 2 }
  ]);
});
