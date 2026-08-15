import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const sourceFile = argument("--source-file");
const actionLog = argument("--action-log");
const port = Number(argument("--port", "0"));
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be an integer from 0 to 65535");

const processIncarnation = randomUUID();

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("connection", "close");
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text, "utf8") > 1_048_576) {
        rejectBody(new Error("request body is too large"));
        request.resume();
      }
    });
    request.on("end", () => resolveBody(text));
    request.on("error", rejectBody);
  });
}

async function currentState() {
  let bytes;
  try {
    bytes = await readFile(sourceFile);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
  const state = JSON.parse(bytes.toString("utf8"));
  if (state === null || typeof state !== "object" || typeof state.resourceId !== "string" || typeof state.incarnationId !== "string") throw new Error("fixture state must contain resourceId and incarnationId");
  return {
    resourceId: state.resourceId,
    incarnationId: state.incarnationId,
    revision: state.revision,
    value: state.value,
    version: { scheme: "sha256", token: createHash("sha256").update(bytes).digest("hex") },
    processIncarnation,
    nodeVersion: process.versions.node
  };
}

async function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { ok: true, pid: process.pid, nodeVersion: process.versions.node, processIncarnation });
    return;
  }
  if (request.method === "GET" && url.pathname === "/state") {
    const state = await currentState();
    if (state === undefined) {
      json(response, 404, { status: "UNKNOWN", reason: "source-missing" });
      return;
    }
    json(response, 200, state);
    return;
  }
  if (request.method === "POST" && url.pathname === "/guard") {
    const bodyText = await readBody(request);
    const body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
    if (typeof body.expectedVersion !== "string" || typeof body.actionId !== "string") {
      json(response, 400, { decision: "REJECT", status: "INVALID" });
      return;
    }
    const state = await currentState();
    if (state === undefined) {
      json(response, 503, { decision: "REJECT", status: "UNKNOWN", reason: "source-missing" });
      return;
    }
    if (body.expectedVersion !== state.version.token) {
      json(response, 409, {
        decision: "REJECT",
        status: "STALE",
        expectedVersion: body.expectedVersion,
        currentVersion: state.version,
        processIncarnation
      });
      return;
    }
    await appendFile(actionLog, JSON.stringify({ actionId: body.actionId, version: state.version, processIncarnation }) + "\n", "utf8");
    json(response, 200, { decision: "ALLOW", status: "FRESH", actionId: body.actionId, version: state.version, processIncarnation });
    return;
  }
  json(response, 404, { error: "not found" });
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    else response.destroy();
  });
});
server.keepAliveTimeout = 100;
server.headersTimeout = 1_000;

function shutdown() {
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("HTTP fixture did not receive a TCP address");
  console.log(JSON.stringify({ event: "ready", port: address.port, processIncarnation, nodeVersion: process.versions.node }));
});
