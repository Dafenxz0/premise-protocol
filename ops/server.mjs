import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";
import { PremiseServer } from "@premise/premise-server/v2";
import { InMemoryRuntimeStore, PremiseRuntime } from "@premise/runtime-core";
import { Metrics } from "./metrics.mjs";
import { createBearerAuthorizer } from "./auth.mjs";
import { openPgClient } from "./pg-client.mjs";
import { openDurableMirror } from "./runtime-store.mjs";
import { shouldFlushDurableWrite } from "./route-durability.mjs";

const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: integer("PORT", 3000, 1, 65_535),
  tenantId: required("PREMISE_TENANT_ID", "tenant:local"),
  environment: process.env.PREMISE_ENV ?? "development",
  apiToken: process.env.PREMISE_API_TOKEN,
  storeMode: process.env.PREMISE_STORE_MODE ?? "postgres",
  tablePrefix: process.env.PREMISE_TABLE_PREFIX ?? "premise_v2",
  maxBodyBytes: integer("PREMISE_MAX_BODY_BYTES", 1_048_576, 1, 64 * 1_024 * 1_024)
};

if (config.storeMode !== "postgres" && config.storeMode !== "memory") throw new Error("PREMISE_STORE_MODE must be postgres or memory");
const authorize = createBearerAuthorizer({ environment: config.environment, token: config.apiToken, tenantId: config.tenantId });

const metrics = new Metrics();
let database;
let store;
let idempotencyStore;
let runtime;
let app;

if (config.storeMode === "postgres") {
  try {
    database = await openPgClient();
    const opened = await openDurableMirror(database, config.tablePrefix, config.tenantId);
    store = opened.mirror;
    idempotencyStore = opened.persistent;
  } catch (error) {
    console.error("PREMiSE v2 startup failed: PostgreSQL is unavailable");
    console.error(error?.code ?? error?.name ?? "database error");
    await database?.close?.();
    process.exitCode = 1;
    throw error;
  }
} else {
  store = new InMemoryRuntimeStore();
}

runtime = new PremiseRuntime({
  store,
  tenantId: config.tenantId,
  principal: { tenantId: config.tenantId, subjectId: "premise-service" }
});

app = new PremiseServer({
  runtime,
  principal: { tenantId: config.tenantId, subjectId: "premise-service" },
  allowTenantHeader: false,
  authorize,
  idempotencyStore,
  awaitDurability: () => store.flush(),
  maxBodyBytes: config.maxBodyBytes,
  logger: (message) => console.error("PREMiSE v2 request error", message.split("\n", 1)[0])
});

for (const record of runtime.list()) {
  const content = typeof record.content === "string" ? record.content : JSON.stringify(record.content) ?? String(record.content);
  await app.index.upsert({ id: record.envelope.memoryId, text: content, content: record.content, metadata: { tenantId: record.envelope.tenantId } });
}

function required(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

function integer(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
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
    const result = await readiness();
    json(response, result.ready ? 200 : 503, { ok: result.ready, ...result });
    return;
  }
  if (request.method === "GET" && pathname === "/metrics") {
    const ready = store.failure === undefined;
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    response.end(metrics.render({ storeReady: ready, pendingWrites: store.pendingWrites ?? 0, records: store.list() }));
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
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`PREMiSE v2 shutting down (${signal})`);
  await new Promise((resolve) => httpServer.close(() => resolve()));
  try { await store.flush?.(); } catch { /* a failed queue is already reflected in readiness */ }
  await database?.close?.();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
