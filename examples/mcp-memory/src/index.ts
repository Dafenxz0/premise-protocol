import { McpBridge } from "@premise/mcp-bridge";
import { ReferenceProtocol } from "@premise/reference-ts";

export async function runMcpMemoryExample(): Promise<string> {
  const at = "2026-08-09T19:20:00Z";
  const sourceUri = "mcp://demo/fact";
  let current = { sourceUri, version: { scheme: "mcp.epoch", token: "1" } };
  const reader = { async read(uri: string) { if (uri !== sourceUri) throw new Error("missing"); return current; } };
  const protocol = new ReferenceProtocol();
  const envelope = { specVersion: "premise/0.1" as const, memoryId: "memory:mcp-example", provenance: [{ sourceUri, observedAt: at, version: current.version, validator: { id: "mcp", operation: "read" } }], validity: { status: "FRESH" as const, checkedAt: at, policy: "VERSIONED" as const }, dependsOn: [] };
  protocol.register(envelope);
  const bridge = new McpBridge(protocol, reader);
  bridge.subscribe(sourceUri, [envelope.memoryId]);
  current = { sourceUri, version: { scheme: "mcp.epoch", token: "2" } };
  bridge.signal({ eventId: "mcp-example-change", sourceUri, version: current.version, occurredAt: at });
  await bridge.reread([envelope.memoryId]);
  return protocol.check([envelope.memoryId]).items[0]?.decision ?? "REJECT";
}
