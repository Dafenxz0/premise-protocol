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
const SELFTEST_MEMORY_ID = "selftest:premise";
const SELFTEST_TIMESTAMP = "2026-08-15T00:00:00.000Z";

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

function selftestRecord() {
  return {
    envelope: {
      specVersion: "premise/2",
      tenantId: "selftest",
      memoryId: SELFTEST_MEMORY_ID,
      evidence: [{
        evidenceId: "evidence:selftest:premise",
        sourceUri: "selftest://premise",
        observedAt: SELFTEST_TIMESTAMP,
        version: { scheme: "selftest", token: "v1" }
      }],
      confidence: { score: null, method: "selftest-mcp", assessedAt: SELFTEST_TIMESTAMP },
      conflicts: [],
      temporal: { asOf: SELFTEST_TIMESTAMP },
      validity: { status: "FRESH", checkedAt: SELFTEST_TIMESTAMP, policy: "VERSIONED" },
      dependsOn: [],
      signatures: []
    },
    content: {
      mode: "SELFTEST",
      message: "PREMiSE MCP is running in deterministic self-test mode; it is not a local coherence store."
    }
  };
}

function selftestValidation(memoryId) {
  return {
    memoryId,
    result: "UNCHANGED",
    status: "FRESH",
    checkedAt: SELFTEST_TIMESTAMP,
    sourceUri: "selftest://premise",
    version: { scheme: "selftest", token: "v1" },
    evidenceId: "evidence:selftest:premise",
    reason: "deterministic self-test source is unchanged"
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
    ? (baseUrl ? "REMOTE" : "SELFTEST")
    : configuredMode).toUpperCase();
  if (mode === "SELFTEST") {
    return {
      getMemory: async (memoryId) => {
        if (memoryId !== SELFTEST_MEMORY_ID) throw new Error(`Unknown self-test memory: ${memoryId}`);
        return selftestRecord();
      },
      revalidate: async (memoryId) => {
        if (memoryId !== SELFTEST_MEMORY_ID) throw new Error(`Unknown self-test memory: ${memoryId}`);
        return selftestValidation(memoryId);
      }
    };
  }
  if (mode === "REMOTE") return remoteClient(environment);
  throw new Error("PREMISE_MODE must be SELFTEST or REMOTE");
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
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function startTransport(client) {
  let buffer = "";
  const decoder = new TextDecoder();
  process.stdin.on("data", (chunk) => {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let payload = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (payload.endsWith("\r")) payload = payload.slice(0, -1);
      if (payload.length === 0) continue;
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
  process.stdin.on("end", () => {
    const payload = decoder.decode();
    if (payload.length > 0) {
      buffer += payload;
      if (buffer.trim().length > 0) errorResponse(null, -32700, "MCP message must end with a newline");
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
