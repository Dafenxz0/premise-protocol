import assert from "node:assert/strict";
import {
  MemoryWebhookDedupStore,
  WebhookConnector,
  WebhookReplayError,
  WebhookSignatureError,
  parseWebhook,
  signWebhookPayload
} from "../dist/index.js";

const secret = "test-webhook-secret";
const now = 1_723_200_000_000;
const timestamp = String(Math.floor(now / 1000));
const body = JSON.stringify({ type: "MemoryRegistered", memoryId: "memory:1" });
const signature = signWebhookPayload(body, secret, timestamp);
const headers = {
  "x-webhook-signature": signature,
  "x-webhook-timestamp": timestamp,
  "x-webhook-id": "delivery:1"
};

const parsed = parseWebhook(body, headers, { secret, now: () => now });
assert.deepEqual(parsed.payload, { type: "MemoryRegistered", memoryId: "memory:1" });
assert.equal(parsed.deliveryId, "delivery:1");
assert.throws(() => parseWebhook(body, { ...headers, "x-webhook-signature": "sha256=bad" }, { secret, now: () => now }), WebhookSignatureError);
assert.throws(() => parseWebhook(body, { ...headers, "x-webhook-timestamp": String(Number(timestamp) - 1) }, { secret, now: () => now }), WebhookSignatureError);
const oldTimestamp = String(Number(timestamp) - 600);
assert.throws(() => parseWebhook(body, { ...headers, "x-webhook-timestamp": oldTimestamp, "x-webhook-signature": signWebhookPayload(body, secret, oldTimestamp) }, { secret, now: () => now }), WebhookReplayError);
const malformedBody = "{";
assert.throws(() => parseWebhook(malformedBody, { ...headers, "x-webhook-signature": signWebhookPayload(malformedBody, secret, timestamp) }, { secret, now: () => now }), /JSON/);

const dedup = new MemoryWebhookDedupStore();
const connector = new WebhookConnector({ secret, dedupStore: dedup, now: () => now, maxRetries: 2, retryDelayMs: 0, timeoutMs: 1000, fetch: async () => new Response("ok", { status: 202 }) });
const received = await Promise.all([connector.receive(body, headers), connector.receive(body, headers)]);
assert.equal(received.filter((item) => !item.duplicate).length, 1);
assert.equal(received.filter((item) => item.duplicate).length, 1);

const retryStatuses = [500, 502, 202];
let calls = 0;
const outbound = new WebhookConnector({
  secret,
  now: () => now,
  retryDelayMs: 0,
  maxRetryDelayMs: 0,
  timeoutMs: 1000,
  fetch: async (_url, request) => {
    calls += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-webhook-id"], "delivery:outbound");
    return new Response("result", { status: retryStatuses[calls - 1], headers: { "retry-after": "0" } });
  }
});
const delivery = await outbound.deliver({ url: "https://example.test/hook", payload: { ok: true }, deliveryId: "delivery:outbound", timestamp });
assert.equal(delivery.response.status, 202);
assert.equal(delivery.attempts, 3);
assert.equal(calls, 3);

let handled = 0;
const releasable = new WebhookConnector({ secret, dedupStore: new MemoryWebhookDedupStore(), now: () => now, fetch: async () => new Response("ok") });
await assert.rejects(() => releasable.handle(body, headers, () => { throw new Error("temporary"); }), /temporary/);
await releasable.handle(body, headers, () => { handled += 1; });
assert.equal(handled, 1);

console.log("connector-webhook tests passed");
