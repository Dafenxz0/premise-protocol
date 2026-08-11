import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GitHubApiError,
  GitHubRateLimitError,
  GitHubTimeoutError,
  GitHubValidator,
  GitHubWebhookError,
  parseGitHubSource,
  parseWebhook,
  signWebhookPayload,
  verifyWebhookSignature
} from "../dist/index.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = async (name) => JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"));
const commit = await fixture("commit.json");
const issue = await fixture("issue.json");
const pullRequest = await fixture("pull-request.json");
const checks = await fixture("check-runs.json");
const reviews = await fixture("reviews.json");
const rateLimit = await fixture("rate-limit.json");
const rawWebhook = await readFile(path.join(fixtureDir, "webhook-pull-request.json"), "utf8");

const requests = [];
let issueBody = issue;
let issueEtag = '"issue-v1"';
let retryAttempts = 0;
let rateLimitAttempts = 0;

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
  requests.push({ path: requestUrl.pathname, query: requestUrl.search, headers: request.headers });
  const rateHeaders = {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4988",
    "x-ratelimit-reset": "1796900000",
    "x-ratelimit-used": "12",
    "x-ratelimit-resource": "core"
  };
  const send = (status, body, headers = {}) => {
    if (response.destroyed) return;
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(body === undefined ? "" : JSON.stringify(body));
  };
  const sendJson = (body, etag) => {
    if (etag && request.headers["if-none-match"] === etag) {
      send(304, undefined, { ...rateHeaders, etag });
      return;
    }
    send(200, body, { ...rateHeaders, ...(etag ? { etag } : {}) });
  };
  const pathName = requestUrl.pathname;
  if (pathName === "/rate_limit") return sendJson(rateLimit);
  if (pathName === "/repos/acme/widget/commits/1111111111111111111111111111111111111111") return sendJson(commit, '"commit-v1"');
  if (pathName === "/repos/acme/widget/issues/42") return sendJson(issueBody, issueEtag);
  if (pathName === "/repos/acme/widget/pulls/42") return sendJson(pullRequest, '"pull-v1"');
  if (pathName === "/repos/acme/widget/commits/1111111111111111111111111111111111111111/check-runs") return sendJson(checks, '"checks-v1"');
  if (pathName === "/repos/acme/widget/pulls/42/reviews") return sendJson(reviews, '"reviews-v1"');
  if (pathName === "/repos/acme/retry/commits/main") {
    retryAttempts += 1;
    if (retryAttempts === 1) return send(500, { message: "temporary failure", token: "test-secret" });
    return sendJson({ ...commit, sha: "3333333333333333333333333333333333333333" }, '"retry-v2"');
  }
  if (pathName === "/repos/acme/limited/issues/1") {
    rateLimitAttempts += 1;
    return send(429, { message: "API rate limit exceeded", token: "test-secret" }, {
      "retry-after": "0",
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
      "x-ratelimit-used": "60",
      "x-ratelimit-resource": "core"
    });
  }
  if (pathName === "/repos/acme/slow-coalesced/commits/main") {
    setTimeout(() => sendJson(commit), 100);
    return;
  }
  if (pathName === "/repos/acme/auth-context/commits/main") {
    setTimeout(() => sendJson(commit), 100);
    return;
  }
  if (pathName === "/repos/acme/slow/commits/main") {
    setTimeout(() => sendJson(commit), 100);
    return;
  }
  if (pathName === "/repos/acme/widget/issues/999") return send(404, { message: "not found", token: "test-secret" });
  return send(404, { message: "unhandled route", token: "test-secret" });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
assert.equal(typeof address, "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const adapter = new GitHubValidator({
  baseUrl,
  tokenProvider: () => "test-secret",
  retryDelayMs: 0,
  maxRetryDelayMs: 0,
  timeoutMs: 500
});

try {
  assert.deepEqual(parseGitHubSource("github://acme/widget/commit/main"), { kind: "commit", owner: "acme", repo: "widget", ref: "main" });
  assert.deepEqual(parseGitHubSource("https://github.com/acme/widget/issues/42"), { kind: "issue", owner: "acme", repo: "widget", number: 42 });
  assert.deepEqual(parseGitHubSource("github://acme/widget/pulls/42/head"), { kind: "pull-request-head", owner: "acme", repo: "widget", number: 42 });
  assert.throws(() => parseGitHubSource("https://example.invalid/acme/widget/issues/42"), /Unsupported GitHub source URI/);

  const commitUri = "github://acme/widget/commit/1111111111111111111111111111111111111111";
  const firstCommit = await adapter.versionFor(commitUri);
  assert.deepEqual(firstCommit, { scheme: "github.commit", token: commit.sha });
  const secondCommit = await adapter.versionFor(commitUri);
  assert.deepEqual(secondCommit, firstCommit);
  const commitRequests = requests.filter(({ path: pathName }) => pathName.endsWith("/commits/1111111111111111111111111111111111111111"));
  assert.equal(commitRequests.length, 2);
  assert.equal(commitRequests[0].headers["if-none-match"], undefined);
  assert.equal(commitRequests[1].headers["if-none-match"], '"commit-v1"');
  assert.equal(commitRequests[0].headers.authorization, "Bearer test-secret");
  assert.equal(commitRequests[0].headers["x-github-api-version"], "2022-11-28");

  const unchanged = await adapter.validate({ sourceUri: commitUri, observedAt: "2026-08-09T19:20:00Z", version: firstCommit });
  assert.equal(unchanged.result, "UNCHANGED");
  assert.equal(unchanged.status, "FRESH");

  const issueUri = "github://acme/widget/issues/42";
  const firstIssue = await adapter.versionFor(issueUri);
  issueBody = { ...issueBody, updated_at: "2026-08-10T08:00:00Z", title: "Track the finished validator rollout" };
  issueEtag = '"issue-v2"';
  const changedIssue = await adapter.validate({ sourceUri: issueUri, observedAt: "2026-08-09T19:20:00Z", version: firstIssue });
  assert.equal(changedIssue.result, "CHANGED");
  assert.equal(changedIssue.status, "INVALID");
  assert.notEqual(changedIssue.version?.token, firstIssue.token);

  const pullVersion = await adapter.versionFor("github://acme/widget/pulls/42");
  assert.equal(pullVersion.scheme, "github.pull-request");
  assert.match(pullVersion.token, new RegExp(pullRequest.head.sha));
  const headVersion = await adapter.versionFor("github://acme/widget/pulls/42/head");
  assert.deepEqual(headVersion, { scheme: "github.pull-request.head", token: pullRequest.head.sha });
  const checksVersion = await adapter.versionFor("github://acme/widget/pulls/42/checks");
  assert.equal(checksVersion.scheme, "github.pull-request.checks");
  assert.match(checksVersion.token, new RegExp(pullRequest.head.sha));
  const reviewsVersion = await adapter.versionFor("github://acme/widget/pulls/42/reviews");
  assert.equal(reviewsVersion.scheme, "github.pull-request.reviews");
  assert.match(reviewsVersion.token, /^sha256:/);

  const rate = await adapter.getRateLimit();
  assert.equal(rate.resources.core.remaining, 4988);
  assert.equal(adapter.lastRateLimit?.remaining, 5000 - 12);

  const coalescingAdapter = new GitHubValidator({ baseUrl, token: "static-secret", retryDelayMs: 0, maxRetryDelayMs: 0, timeoutMs: 500 });
  const coalescedPath = "/repos/acme/slow-coalesced/commits/main";
  const coalescedBefore = requests.filter(({ path: pathName }) => pathName === coalescedPath).length;
  const coalescedFirstPromise = coalescingAdapter.get(coalescedPath);
  const coalescedSecondPromise = coalescingAdapter.get(coalescedPath);
  const [coalescedFirst, coalescedSecond] = await Promise.all([coalescedFirstPromise, coalescedSecondPromise]);
  assert.equal(requests.filter(({ path: pathName }) => pathName === coalescedPath).length - coalescedBefore, 1);
  assert.deepEqual(coalescedFirst, coalescedSecond);
  assert.notEqual(coalescedFirst, coalescedSecond);
  coalescedFirst.author.login = "mutated-by-first-caller";
  assert.equal(coalescedSecond.author.login, "octocat");

  const authTokens = ["token-a", "token-b"];
  const authAdapter = new GitHubValidator({
    baseUrl,
    tokenProvider: () => authTokens.shift(),
    retryDelayMs: 0,
    maxRetryDelayMs: 0,
    timeoutMs: 500
  });
  const authPath = "/repos/acme/auth-context/commits/main";
  const authFirstPromise = authAdapter.get(authPath);
  const authSecondPromise = authAdapter.get(authPath);
  await Promise.all([authFirstPromise, authSecondPromise]);
  const authRequests = requests.filter(({ path: pathName }) => pathName === authPath);
  assert.equal(authRequests.length, 2);
  assert.deepEqual(
    authRequests.map(({ headers }) => headers.authorization).sort(),
    ["Bearer token-a", "Bearer token-b"]
  );

  const retryAdapter = new GitHubValidator({ baseUrl, token: "retry-secret", retryDelayMs: 0, maxRetryDelayMs: 0, timeoutMs: 500 });
  const retried = await retryAdapter.versionFor("github://acme/retry/commit/main");
  assert.equal(retried.token, "3333333333333333333333333333333333333333");
  assert.equal(retryAttempts, 2);

  const limitedAdapter = new GitHubValidator({ baseUrl, retryDelayMs: 0, maxRetryDelayMs: 0, maxRetries: 1, timeoutMs: 500 });
  await assert.rejects(
    () => limitedAdapter.get("/repos/acme/limited/issues/1"),
    (error) => error instanceof GitHubRateLimitError && error.code === "GITHUB_RATE_LIMITED" && error.rateLimit?.remaining === 0 && error.retryAfterMs === 0
  );
  assert.equal(rateLimitAttempts, 2);

  await assert.rejects(
    () => adapter.get("/repos/acme/widget/issues/999"),
    (error) => error instanceof GitHubApiError && error.status === 404 && !error.message.includes("test-secret") && !error.message.includes("not found")
  );
  const missing = await adapter.validate({ sourceUri: "github://acme/widget/issues/999", observedAt: "2026-08-09T19:20:00Z" });
  assert.equal(missing.result, "MISSING");
  assert.equal(missing.status, "INVALID");

  const timeoutAdapter = new GitHubValidator({ baseUrl, maxRetries: 0, timeoutMs: 20 });
  await assert.rejects(() => timeoutAdapter.versionFor("github://acme/slow/commit/main"), (error) => error instanceof GitHubTimeoutError);
  const timeoutResult = await timeoutAdapter.validate({ sourceUri: "github://acme/slow/commit/main", observedAt: "2026-08-09T19:20:00Z" });
  assert.equal(timeoutResult.result, "UNKNOWN");
  assert.equal(timeoutResult.status, "UNKNOWN");

  const webhookSecret = "webhook-secret-from-injection";
  const signature = signWebhookPayload(rawWebhook, webhookSecret);
  assert.equal(verifyWebhookSignature(rawWebhook, signature, webhookSecret), true);
  assert.equal(verifyWebhookSignature(rawWebhook, `${signature.slice(0, -1)}0`, webhookSecret), false);
  const webhook = parseWebhook(rawWebhook, {
    "X-Hub-Signature-256": signature,
    "X-GitHub-Event": "pull_request",
    "X-GitHub-Delivery": "9f7d7c2e-0000-0000-0000-000000000042"
  }, webhookSecret);
  assert.equal(webhook.event, "pull_request");
  assert.equal(webhook.deliveryId, "9f7d7c2e-0000-0000-0000-000000000042");
  assert.equal(webhook.payload.action, "synchronize");
  const webhookAdapter = new GitHubValidator({ baseUrl, webhookSecret });
  assert.equal(webhookAdapter.verifyWebhook(rawWebhook, signature), true);
  assert.equal(webhookAdapter.parseWebhook(rawWebhook, { "x-hub-signature-256": signature, "x-github-event": "pull_request" }).payload.number, 42);
  assert.throws(() => webhookAdapter.parseWebhook(rawWebhook, { "x-hub-signature-256": "sha256=bad", "x-github-event": "pull_request" }), GitHubWebhookError);

  console.log("validator-github tests passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
