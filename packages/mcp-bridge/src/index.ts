import { ReferenceProtocol } from "@premise/reference-ts";
import type { SourceReference, ValidationResult, VersionReference } from "@premise/protocol-types";

export interface McpResourceRead {
  readonly sourceUri: string;
  readonly version: VersionReference;
}

export interface McpResourceReader {
  read(sourceUri: string): Promise<McpResourceRead>;
}

export interface McpSourceChangedNotification {
  readonly eventId: string;
  readonly sourceUri: string;
  readonly version: VersionReference;
  readonly occurredAt: string;
}

export interface McpSubscription {
  readonly sourceUri: string;
  readonly memoryIds: readonly string[];
  unsubscribe(): void;
}

export class McpBridge {
  private readonly subscriptions = new Map<string, Map<string, number>>();

  constructor(readonly protocol: ReferenceProtocol, readonly reader: McpResourceReader) {}

  subscribe(sourceUri: string, memoryIds: readonly string[]): McpSubscription {
    const counts = this.subscriptions.get(sourceUri) ?? new Map<string, number>();
    for (const memoryId of memoryIds) {
      if (memoryId.length === 0) throw new Error("MCP subscription memory IDs must be non-empty");
      counts.set(memoryId, (counts.get(memoryId) ?? 0) + 1);
    }
    this.subscriptions.set(sourceUri, counts);
    let active = true;
    return { sourceUri, memoryIds: [...counts.keys()].sort(), unsubscribe: () => {
      if (!active) return;
      active = false;
      for (const memoryId of memoryIds) {
        const count = counts.get(memoryId) ?? 0;
        if (count <= 1) counts.delete(memoryId); else counts.set(memoryId, count - 1);
      }
      if (counts.size === 0) this.subscriptions.delete(sourceUri);
    } };
  }

  signal(notification: McpSourceChangedNotification) {
    return this.protocol.signal({ specVersion: "premise/0.1", eventId: notification.eventId, type: "SourceChanged", occurredAt: notification.occurredAt, payload: { sourceUri: notification.sourceUri, version: notification.version } });
  }

  async reread(memoryIds: readonly string[]): Promise<Awaited<ReturnType<ReferenceProtocol["validate"]>>> {
    const supplied: Record<string, ValidationResult> = {};
    for (const memoryId of memoryIds) {
      const state = this.protocol.states.stateOf(memoryId);
      const source = state?.envelope.provenance?.find((entry) => (this.subscriptions.get(entry.sourceUri)?.get(memoryId) ?? 0) > 0);
      if (!state || !source) { supplied[memoryId] = { memoryId, result: "UNKNOWN", status: "UNKNOWN", checkedAt: new Date().toISOString() }; continue; }
      try {
        const current = await this.reader.read(source.sourceUri);
        if (current.sourceUri !== source.sourceUri || current.version.scheme.length === 0 || current.version.token.length === 0) {
          supplied[memoryId] = { memoryId, result: "UNKNOWN", status: "UNKNOWN", checkedAt: new Date().toISOString(), sourceUri: source.sourceUri };
          continue;
        }
        const result = source.version?.scheme === current.version.scheme && source.version.token === current.version.token ? "UNCHANGED" : "CHANGED";
        supplied[memoryId] = { memoryId, result, status: result === "UNCHANGED" ? "FRESH" : "INVALID", checkedAt: new Date().toISOString(), sourceUri: source.sourceUri, version: current.version };
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        const missing = (error as { readonly code?: unknown })?.code === "NOT_FOUND" || message.includes("not found") || message.includes("missing");
        supplied[memoryId] = { memoryId, result: missing ? "MISSING" : "UNKNOWN", status: missing ? "INVALID" : "UNKNOWN", checkedAt: new Date().toISOString(), sourceUri: source.sourceUri };
      }
    }
    return this.protocol.validate(memoryIds, supplied);
  }
}
