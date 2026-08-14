#!/usr/bin/env node

/**
 * Standalone PREMiSE MCP transport.
 *
 * This file intentionally uses only Node.js built-ins. It is copied with the
 * plugin so a plugin install never resolves a monorepo package or workspace
 * path. The tool contract mirrors the package MCP server: observe, check,
 * explain, and a dry-run guard that never performs a side effect.
 */

const SERVER_VERSION = "0.1.0-rc.1";
const LOCAL_MEMORY_ID = "local:premise";
const LOCAL_TIMESTAMP = "2026-08-15T00:00:00.000Z";

const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    memoryId: { type: "string", minLength: 1, maxLength: 512 }
  },
  required: ["memoryId"],
  additionalProperties: false
};

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    memoryId: { type: "string", minLength: 1, maxLength: 512 },
    action: { type: "string", minLength: 1, maxLength: 2_000 },
    risk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] }
  },
  required: ["memoryId", "action"],
  additionalProperties: false
};

const TOOLS = [
  {
    name: "observe",
    description: "Read one scoped PREMiSE memory and return its evidence and freshness metadata.",
    inputSchema: MEMORY_SCHEMA
  },
  {
    name: "check",
    description: "Revalidate one memory against its source and return the freshness decision.",
    inputSchema: MEMORY_SCHEMA
  },
  {
    name: "explain",
    description: "Explain the latest deterministic PREMiSE validation result for one memory.",
    inputSchema: MEMORY_SCHEMA
  },
  {
    name: "guard",
    description: "Check whether an action may proceed; it never executes the side effect.",
    inputSchema: ACTION_SCHEMA
  }
];

function localRecord() {
  return {
    envelope: {
      specVersion: "premise/2",
      tenantId: "local",
      memoryId: LOCAL_MEMORY_ID,
      evidence: [{
        evidenceId: "evidence:local:premise",
        sourceUri: "local://premise",
        observedAt: LOCAL_TIMESTAMP,
        version: { scheme: "local", token: "v1" }
      }],
      confidence: { score: null, method: "local-mcp", assessedAt: LOCAL_TIMESTAMP },
      conflicts: [],
      temporal: { asOf: LOCAL_TIMESTAMP },
      validity: { status: "FRESH", checkedAt: LOCAL_TIMESTAMP, policy: "VERSIONED" },
      dependsOn: [],
      signatures: []
    },
    content: {
      mode: "LOCAL",
      message: "PREMiSE MCP is running in zero-config local mode."
    }
  };
}

function validation(memoryId) {
  return {
    memoryId,
    result: "UNCHANGED",
    status: "FRESH",
    checkedAt: LOCAL_TIMESTAMP,
    sourceUri: "local://premise",
    version: { scheme: "local", token: "v1" },
    evidenceId: "evidence:local:premise",
    reason: "local deterministic source is unchanged"
  };
}

function requireMemoryId(argumentsValue) {
  const memoryId = argumentsValue?.memoryId;
  if (typeof memoryId !== "string" || memoryId.length === 0 || memoryId.length > 512) {
    throw new Error("memoryId must be a non-empty string of at most 512 characters");
  }
  return memoryId;
}

function observed(record) {
  return {
    memoryId: record.envelope.memoryId,
    tenantId: record.envelope.tenantId,
    status: record.envelope.validity.status,
    checkedAt: record.envelope.validity.checkedAt,
    policy: record.envelope.validity.policy,
    evidence: record.envelope.evidence,
    dependsOn: record.envelope.dependsOn
  };
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function toolFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message }) }]
  };
}

function remoteClient(environment) {
  const baseUrl = environment.PREMISE_BASE_URL?.trim();
  if (!baseUrl) throw new Error("PREMISE_BASE_URL is required in REMOTE mode");
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("PREMISE_BASE_URL must use http or https");

  async function request(method, path) {
    const headers = { accept: "application/json" };
    if (environment.PREMISE_TENANT) headers["x-premise-tenant"] = environment.PREMISE_TENANT;
    if (environment.PREMISE_TOKEN) headers.authorization = `Bearer ${environment.PREMISE_TOKEN}`;
    const response = await fetch(new URL(path.replace(/^\//u, ""), base), { method, headers });
    const body = await response.text();
    let value;
    try {
      value = body.length === 0 ? undefined : JSON.parse(body);
    } catch {
      throw new Error(`PREMiSE remote returned invalid JSON (${response.status})`);
    }
    if (!response.ok) throw new Error(`PREMiSE remote returned HTTP ${response.status}`);
    return value;
  }

  return {
    getMemory: (memoryId) => request("GET", `v2/memories/${encodeURIComponent(memoryId)}`),
    revalidate: (memoryId) => request("POST", `v2/memories/${encodeURIComponent(memoryId)}/revalidate`)
  };
}

function configuredClient(environment) {
  const baseUrl = environment.PREMISE_BASE_URL?.trim();
  const configuredMode = environment.PREMISE_MODE?.trim();
  const mode = (configuredMode === undefined || configuredMode.length === 0
    ? (baseUrl ? "REMOTE" : "LOCAL")
    : configuredMode).toUpperCase();
  if (mode === "LOCAL") {
    return {
      getMemory: async (memoryId) => {
        if (memoryId !== LOCAL_MEMORY_ID) throw new Error(`Unknown local memory: ${memoryId}`);
        return localRecord();
      },
      revalidate: async (memoryId) => {
        if (memoryId !== LOCAL_MEMORY_ID) throw new Error(`Unknown local memory: ${memoryId}`);
        return validation(memoryId);
      }
    };
  }
  if (mode === "REMOTE") return remoteClient(environment);
  throw new Error("PREMISE_MODE must be LOCAL or REMOTE");
}

async function callTool(name, args, client) {
  try {
    if (name === "observe") {
      const memoryId = requireMemoryId(args);
      return toolResult({ operation: "observe", ...observed(await client.getMemory(memoryId)) });
    }
    if (name === "check") {
      const memoryId = requireMemoryId(args);
      return toolResult({ operation: "check", ...await client.revalidate(memoryId) });
    }
    if (name === "explain") {
      const memoryId = requireMemoryId(args);
      const current = await client.revalidate(memoryId);
      return toolResult({
        operation: "explain",
        memoryId,
        decision: current.status === "FRESH" && current.result === "UNCHANGED" ? "USE" : "REVALIDATE_OR_REJECT",
        basis: {
          result: current.result,
          status: current.status,
          checkedAt: current.checkedAt,
          version: current.version,
          reason: current.reason
        }
      });
    }
    if (name === "guard") {
      const memoryId = requireMemoryId(args);
      if (typeof args?.action !== "string" || args.action.length === 0 || args.action.length > 2_000) {
        throw new Error("action must be a non-empty string of at most 2000 characters");
      }
      const risk = args?.risk ?? "HIGH";
      if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(risk)) throw new Error("risk is invalid");
      const current = await client.revalidate(memoryId);
      const allowed = current.status === "FRESH" && current.result === "UNCHANGED";
      return toolResult({
        operation: "guard",
        memoryId,
        action: args.action,
        risk,
        decision: allowed ? "ALLOW" : "REJECT",
        executesSideEffect: false,
        requiresConditionalWrite: allowed,
        validation: current
      });
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return toolFailure(error);
  }
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function errorResponse(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function startTransport(client) {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const separator = buffer.indexOf(Buffer.from("\r\n\r\n"));
      if (separator < 0) return;
      const header = buffer.subarray(0, separator).toString("ascii");
      const lengthHeader = header.split("\r\n").find((line) => /^content-length:/iu.test(line));
      const length = lengthHeader === undefined ? NaN : Number.parseInt(lengthHeader.split(":", 2)[1].trim(), 10);
      if (!Number.isSafeInteger(length) || length < 0) {
        errorResponse(null, -32600, "Invalid Content-Length");
        process.exitCode = 1;
        return;
      }
      const start = separator + 4;
      if (buffer.length < start + length) return;
      const payload = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      let message;
      try {
        message = JSON.parse(payload);
      } catch {
        errorResponse(null, -32700, "Invalid JSON");
        continue;
      }
      void handleMessage(message, client);
    }
  });
  process.stdin.resume();
}

async function handleMessage(message, client) {
  if (!message || typeof message !== "object") {
    errorResponse(null, -32600, "Invalid request");
    return;
  }
  const method = message.method;
  if (typeof method !== "string") return;
  if (method.startsWith("notifications/")) return;
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "premise", version: SERVER_VERSION }
        }
      });
      return;
    }
    if (method === "ping") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
      return;
    }
    if (method === "tools/call") {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {}, client);
      send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    errorResponse(message.id, -32601, `Method not found: ${method}`);
  } catch (error) {
    errorResponse(message.id, -32603, error instanceof Error ? error.message : String(error));
  }
}

try {
  startTransport(configuredClient(process.env));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
