import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { PremiseClient, type MemoryRecord, type RevalidationReport } from "@premise/sdk";
import * as z from "zod/v4";

export const MCP_SERVER_VERSION = "0.1.0-rc.1" as const;

const memoryInput = z.object({
  memoryId: z.string().min(1).max(512)
});

const actionInput = z.object({
  memoryId: z.string().min(1).max(512),
  action: z.string().min(1).max(2_000),
  risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("HIGH")
});

type JsonValue = Record<string, unknown>;

export interface PremiseMcpClient {
  getMemory<TContent = unknown>(memoryId: string): Promise<MemoryRecord<TContent>>;
  revalidate(memoryId: string): Promise<RevalidationReport>;
}

const SELFTEST_TIMESTAMP = "2026-08-15T00:00:00.000Z";
const SELFTEST_MEMORY_ID = "selftest:premise";
const SELFTEST_RECORD: MemoryRecord<unknown> = {
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

class SelftestPremiseClient implements PremiseMcpClient {
  async getMemory<TContent = unknown>(memoryId: string): Promise<MemoryRecord<TContent>> {
    if (memoryId !== SELFTEST_MEMORY_ID) throw new Error(`Unknown self-test memory: ${memoryId}`);
    return SELFTEST_RECORD as MemoryRecord<TContent>;
  }

  async revalidate(memoryId: string): Promise<RevalidationReport> {
    if (memoryId !== SELFTEST_MEMORY_ID) throw new Error(`Unknown self-test memory: ${memoryId}`);
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
}

function result(value: JsonValue) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }]
  };
}

function observed(record: MemoryRecord<unknown>): JsonValue {
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

export function createPremiseMcpServer(client: PremiseMcpClient): McpServer {
  const server = new McpServer({
    name: "premise",
    version: MCP_SERVER_VERSION
  });

  server.registerTool(
    "observe",
    {
      description: "Read one scoped PREMiSE memory and return its evidence and freshness metadata.",
      inputSchema: memoryInput
    },
    async ({ memoryId }) => {
      try {
        return result({ operation: "observe", ...observed(await client.getMemory(memoryId)) });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "check",
    {
      description: "Revalidate one memory against its source and return the freshness decision.",
      inputSchema: memoryInput
    },
    async ({ memoryId }) => {
      try {
        const validation = await client.revalidate(memoryId);
        return result({ operation: "check", ...validation });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "explain",
    {
      description: "Explain the latest deterministic PREMiSE validation result for one memory.",
      inputSchema: memoryInput
    },
    async ({ memoryId }) => {
      try {
        const validation = await client.revalidate(memoryId);
        return result({
          operation: "explain",
          memoryId,
          decision: validation.status === "FRESH" && validation.result === "UNCHANGED" ? "USE" : "REVALIDATE_OR_REJECT",
          basis: {
            result: validation.result,
            status: validation.status,
            checkedAt: validation.checkedAt,
            version: validation.version,
            reason: validation.reason
          }
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "guard",
    {
      description: "Check whether an action may proceed; it never executes the side effect.",
      inputSchema: actionInput
    },
    async ({ memoryId, action, risk }) => {
      try {
        const validation = await client.revalidate(memoryId);
        const allowed = validation.status === "FRESH" && validation.result === "UNCHANGED";
        return result({
          operation: "guard",
          memoryId,
          action,
          risk,
          decision: allowed ? "ALLOW" : "REJECT",
          executesSideEffect: false,
          requiresConditionalWrite: allowed,
          validation
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  return server;
}

export function createConfiguredClient(env: NodeJS.ProcessEnv = process.env): PremiseMcpClient {
  const baseUrl = env.PREMISE_BASE_URL?.trim();
  const configuredMode = env.PREMISE_MODE?.trim();
  const mode = (configuredMode === undefined || configuredMode.length === 0
    ? (baseUrl === undefined || baseUrl.length === 0 ? "SELFTEST" : "REMOTE")
    : configuredMode).toUpperCase();

  if (mode === "SELFTEST") return new SelftestPremiseClient();
  if (mode !== "REMOTE") throw new Error("PREMISE_MODE must be SELFTEST or REMOTE");
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("PREMISE_BASE_URL is required in REMOTE mode");
  }
  return new PremiseClient({
    baseUrl,
    maxRetries: 0,
    ...(env.PREMISE_TENANT === undefined ? {} : { tenantId: env.PREMISE_TENANT }),
    ...(env.PREMISE_TOKEN === undefined ? {} : { token: env.PREMISE_TOKEN })
  });
}

export async function startStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const client = createConfiguredClient(env);
  await serveStdio(() => createPremiseMcpServer(client));
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("index.js")) {
  startStdio().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
