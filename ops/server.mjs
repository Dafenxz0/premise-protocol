import { createPublicKey, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { URL } from "node:url";
import { PremiseServer } from "@premise/premise-server/v2";
import { MemoryV2SignatureReplayStore, parseAndVerifyMemoryEnvelopeV2Async } from "@premise/protocol-types";
import { InMemoryRuntimeStore, PremiseRuntime } from "@premise/runtime-core";
import { PostgresLexicalIndex, PostgresSignatureReplayStore } from "@premise/store-postgres";
import { Metrics } from "./metrics.mjs";
import { assertRlsSafeDatabaseRole, authorizeOperationalRequest, createBearerAuthorizer } from "./auth.mjs";
import { openPgClient } from "./pg-client.mjs";
import { openDurableMirror } from "./runtime-store.mjs";
import { shouldFlushDurableWrite } from "./route-durability.mjs";

const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: integer("PORT", 3000, 1, 65_535),
  tenantId: required("PREMISE_TENANT_ID", "tenant:local"),
  environment: process.env.PREMISE_ENV ?? "development",
  apiToken: process.env.PREMISE_API_TOKEN,
  metricsToken: process.env.PREMISE_METRICS_TOKEN,
  storeMode: process.env.PREMISE_STORE_MODE ?? "postgres",
  tablePrefix: process.env.PREMISE_TABLE_PREFIX ?? "premise_v2",
  signatureKeysFile: process.env.PREMISE_SIGNATURE_KEYS_FILE,
  requireSignedEnvelopes: process.env.PREMISE_REQUIRE_SIGNED_ENVELOPES === "1",
  // The replay table requires expiresAt > acceptedAt; keep this positive and
  // cap it so the two-times retention used below stays within its 24h bound.
  signatureMaxClockSkewMs: integer("PREMISE_SIGNATURE_MAX_CLOCK_SKEW_MS", 5 * 60 * 1_000, 1, 12 * 60 * 60 * 1_000),
  maxBodyBytes: integer("PREMISE_MAX_BODY_BYTES", 1_048_576, 1, 64 * 1_024 * 1_024),
  runtimeWriteConcurrency: integer("PREMISE_RUNTIME_WRITE_CONCURRENCY", 4, 1, 64),
  runtimeMaxPendingWrites: integer("PREMISE_RUNTIME_MAX_PENDING_WRITES", 10_000, 1, 1_000_000),
  httpIdempotencyRetentionMs: integer("PREMISE_HTTP_IDEMPOTENCY_RETENTION_MS", 7 * 24 * 60 * 60 * 1_000, 60 * 60 * 1_000, 365 * 24 * 60 * 60 * 1_000),
  httpIdempotencyCleanupIntervalMs: integer("PREMISE_HTTP_IDEMPOTENCY_CLEANUP_INTERVAL_MS", 60 * 60 * 1_000, 60 * 1_000, 24 * 60 * 60 * 1_000)
};

if (config.storeMode !== "postgres" && config.storeMode !== "memory") throw new Error("PREMISE_STORE_MODE must be postgres or memory");
const authorize = createBearerAuthorizer({ environment: config.environment, token: config.apiToken, tenantId: config.tenantId });
const authorizeMetrics = createBearerAuthorizer({ environment: config.environment, token: config.metricsToken, tokenName: "PREMISE_METRICS_TOKEN", tenantId: config.tenantId });
const signatureKeys = await loadSignatureKeys(config.signatureKeysFile);
if (config.requireSignedEnvelopes && signatureKeys === undefined) {
  throw new Error("PREMISE_REQUIRE_SIGNED_ENVELOPES=1 requires PREMiSE_SIGNATURE_KEYS_FILE with external public keys");
}
if (!isDevelopmentEnvironment(config.environment) && !config.requireSignedEnvelopes) {
  throw new Error("PREMISE_REQUIRE_SIGNED_ENVELOPES=1 is mandatory outside development");
}
if (!isDevelopmentEnvironment(config.environment) && signatureKeys !== undefined && config.storeMode !== "postgres") {
  throw new Error("PREMISE_SIGNATURE_KEYS_FILE requires PostgreSQL-backed replay protection outside development; use PREMiSE_STORE_MODE=postgres with migration 007 applied");
}

const metrics = new Metrics();
let database;
let store;
let idempotencyStore;
let runtime;
let retrievalIndex;
let runtimeCounts;
let app;
let signatureVerification;

if (config.storeMode === "postgres") {
  try {
    database = await openPgClient();
    assertRlsSafeDatabaseRole(await database.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"));
    const opened = await openDurableMirror(database, config.tablePrefix, config.tenantId, {
      concurrency: config.runtimeWriteConcurrency,
      maxPendingWrites: config.runtimeMaxPendingWrites
    });
    store = opened.mirror;
    idempotencyStore = opened.persistent;
    retrievalIndex = new PostgresLexicalIndex(opened.persistent, { awaitDurability: () => opened.mirror.flush() });
    runtimeCounts = () => opened.persistent.counts();
    if (signatureKeys !== undefined) {
      const replayStore = new PostgresSignatureReplayStore(database, {
        tablePrefix: config.tablePrefix,
        tenantId: config.tenantId,
        retentionMs: Math.max(config.signatureMaxClockSkewMs * 2, 10 * 60 * 1_000)
      });
      await replayStore.initialize();
      signatureVerification = { keys: signatureKeys, replayStore, maxClockSkewMs: config.signatureMaxClockSkewMs };
    }
  } catch (error) {
    console.error("PREMiSE v2 startup failed: PostgreSQL is unavailable");
    console.error(error?.code ?? error?.name ?? "database error");
    await database?.close?.();
    process.exitCode = 1;
    throw error;
  }
} else {
  store = new InMemoryRuntimeStore();
  if (signatureKeys !== undefined) {
    signatureVerification = {
      keys: signatureKeys,
      replayStore: new MemoryV2SignatureReplayStore(),
      maxClockSkewMs: config.signatureMaxClockSkewMs
    };
  }
}

runtime = new PremiseRuntime({
  store,
  tenantId: config.tenantId,
  principal: { tenantId: config.tenantId, subjectId: "premise-service" }
});

app = new PremiseServer({
  runtime,
  index: retrievalIndex,
  runtimeCounts,
  principal: { tenantId: config.tenantId, subjectId: "premise-service" },
  allowTenantHeader: false,
  authorize,
  idempotencyStore,
  awaitDurability: () => store.flush(),
  maxBodyBytes: config.maxBodyBytes,
  ...(signatureVerification === undefined ? {} : {
    verifyEnvelope: (input) => parseAndVerifyMemoryEnvelopeV2Async(input, signatureVerification)
  }),
  logger: (message) => console.error("PREMiSE v2 request error", message.split("\n", 1)[0])
});

function required(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

function isDevelopmentEnvironment(environment) {
  return typeof environment === "string" && environment.trim().toLowerCase() === "development";
}

function integer(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

async function loadSignatureKeys(file) {
  if (file === undefined || file.length === 0) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`PREMISE_SIGNATURE_KEYS_FILE cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PREMISE_SIGNATURE_KEYS_FILE must contain a JSON object keyed by keyId");
  const keys = new Map();
  for (const [keyId, value] of Object.entries(parsed)) {
    if (!/^\S{1,256}$/u.test(keyId) || typeof value !== "string" || value.length === 0 || value.length > 16_384) throw new Error("PREMISE_SIGNATURE_KEYS_FILE contains an invalid key entry");
    if (/PRIVATE KEY/u.test(value)) throw new Error(`PREMISE_SIGNATURE_KEYS_FILE must contain public keys only (private material found for ${keyId})`);
    let publicKey;
    try {
      publicKey = createPublicKey(value);
    } catch {
      throw new Error(`PREMISE_SIGNATURE_KEYS_FILE contains an invalid public key for ${keyId}`);
    }
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`PREMISE_SIGNATURE_KEYS_FILE key ${keyId} must be a public Ed25519 key`);
    }
    keys.set(keyId, publicKey);
  }
  if (keys.size === 0) throw new Error("PREMISE_SIGNATURE_KEYS_FILE must contain at least one public key");
  return keys;
}

function safeRequestId(request) {
  const incoming = request.headers["x-request-id"];
  return typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function readiness() {
  const checks = { process: "ok", store: "ok", database: config.storeMode === "postgres" ? "ok" : "not_required" };
  if (store.failure !== undefined) checks.store = "error";
  if (config.storeMode === "postgres") {
    try {
      await database.query("SELECT 1");
    } catch {
      checks.database = "error";
    }
  }
  const ready = Object.values(checks).every((value) => value === "ok" || value === "not_required");
  return { ready, checks };
}

function installResponseBarrier(request, response, pathname, requestId, startedAt) {
  const originalEnd = response.end.bind(response);
  let ended = false;
  response.end = function guardedEnd(chunk, encoding, callback) {
    if (ended) return response;
    ended = true;
    const callbackFunction = typeof encoding === "function" ? encoding : typeof callback === "function" ? callback : undefined;
    const encodingValue = typeof encoding === "string" ? encoding : undefined;
    void (async () => {
      let output = chunk;
      let outputEncoding = encodingValue;
      let outputCallback = callbackFunction;
      if (shouldFlushDurableWrite(pathname, request.method ?? "GET", config.storeMode)) {
        try {
          await store.flush();
        } catch (error) {
          metrics.recordPersistenceFailure();
          if (!response.headersSent) {
            response.statusCode = 503;
            response.setHeader("content-type", "application/json; charset=utf-8");
          }
          output = JSON.stringify({ ok: false, error: "persistence_unavailable", requestId });
          outputEncoding = "utf8";
          outputCallback = callbackFunction;
          console.error("PREMiSE v2 persistence failure", error?.code ?? error?.name ?? "database error");
        }
      }
      metrics.observeRequest(request.method ?? "GET", pathname, response.statusCode || 200, Number(process.hrtime.bigint() - startedAt) / 1_000_000);
      if (outputEncoding !== undefined) {
        if (outputCallback !== undefined) originalEnd(output, outputEncoding, outputCallback);
        else originalEnd(output, outputEncoding);
      } else if (outputCallback !== undefined) {
        originalEnd(output, outputCallback);
      } else {
        originalEnd(output);
      }
    })().catch((error) => {
      metrics.observeRequest(request.method ?? "GET", pathname, 500, Number(process.hrtime.bigint() - startedAt) / 1_000_000);
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json; charset=utf-8");
        originalEnd(JSON.stringify({ ok: false, error: "internal_error", requestId }));
      } else {
        originalEnd();
      }
      console.error("PREMiSE v2 response failure", error?.code ?? error?.name ?? "unknown error");
    });
    return response;
  };
}

const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://premise.local");
  const pathname = url.pathname;
  const requestId = safeRequestId(request);
  const startedAt = process.hrtime.bigint();
  response.setHeader("x-request-id", requestId);
  response.setHeader("cache-control", "no-store");
  installResponseBarrier(request, response, pathname, requestId, startedAt);
  request.setTimeout(30_000);

  if (request.method === "POST") {
    const contentLength = request.headers["content-length"];
    if (typeof contentLength === "string" && Number.parseInt(contentLength, 10) > config.maxBodyBytes) {
      request.resume();
      json(response, 413, { ok: false, error: "body_too_large", requestId });
      return;
    }
  }

  if (request.method === "GET" && pathname === "/readyz") {
    if (!authorizeOperationalRequest(authorize, request, { tenantId: config.tenantId, subjectId: "premise-ops" }, { allowLoopback: true })) {
      response.setHeader("www-authenticate", "Bearer");
      json(response, 401, { ok: false, error: "unauthorized", requestId });
      return;
    }
    const result = await readiness();
    json(response, result.ready ? 200 : 503, { ok: result.ready, ...result });
    return;
  }
  if (request.method === "GET" && pathname === "/metrics") {
    if (!authorizeOperationalRequest(authorizeMetrics, request, { tenantId: config.tenantId, subjectId: "premise-metrics" })) {
      response.setHeader("www-authenticate", "Bearer");
      json(response, 401, { ok: false, error: "unauthorized", requestId });
      return;
    }
    const ready = store.failure === undefined;
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    const freshness = store.freshnessCounts;
    response.end(metrics.render({
      storeReady: ready,
      pendingWrites: store.pendingWrites ?? 0,
      maxPendingWrites: store.maxPendingWrites ?? 0,
      freshness,
      records: freshness === undefined ? store.list() : undefined
    }));
    return;
  }

  try {
    await app.handle(request, response);
  } catch (error) {
    console.error("PREMiSE v2 handler failure", error?.code ?? error?.name ?? "unknown error");
    if (!response.headersSent) json(response, 500, { ok: false, error: "internal_error", requestId });
  }
});

httpServer.requestTimeout = 30_000;
httpServer.headersTimeout = 10_000;
httpServer.keepAliveTimeout = 5_000;

await new Promise((resolve) => httpServer.listen(config.port, config.host, resolve));
console.log(`PREMiSE v2 listening on ${config.host}:${config.port} (${config.storeMode})`);

let shuttingDown = false;
let idempotencyCleanupTimer;
if (idempotencyStore !== undefined && typeof idempotencyStore.pruneHttpIdempotency === "function") {
  const cleanup = () => void idempotencyStore.pruneHttpIdempotency({ maxAgeMs: config.httpIdempotencyRetentionMs }).catch((error) => {
    console.error("PREMiSE v2 idempotency cleanup failed", error?.code ?? error?.name ?? "database error");
  });
  idempotencyCleanupTimer = setInterval(cleanup, config.httpIdempotencyCleanupIntervalMs);
  idempotencyCleanupTimer.unref?.();
  cleanup();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`PREMiSE v2 shutting down (${signal})`);
  if (idempotencyCleanupTimer !== undefined) clearInterval(idempotencyCleanupTimer);
  await new Promise((resolve) => httpServer.close(() => resolve()));
  try { await store.flush?.(); } catch { /* a failed queue is already reflected in readiness */ }
  await database?.close?.();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
