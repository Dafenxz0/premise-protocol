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
  private readonly subscriptions = new Map<string, Set<string>>();

  constructor(readonly protocol: ReferenceProtocol, readonly reader: McpResourceReader) {}

  subscribe(sourceUri: string, memoryIds: readonly string[]): McpSubscription {
    const set = this.subscriptions.get(sourceUri) ?? new Set<string>();
    for (const memoryId of memoryIds) set.add(memoryId);
    this.subscriptions.set(sourceUri, set);
    return { sourceUri, memoryIds: [...set].sort(), unsubscribe: () => { for (const memoryId of memoryIds) set.delete(memoryId); if (set.size === 0) this.subscriptions.delete(sourceUri); } };
  }

  signal(notification: McpSourceChangedNotification) {
    return this.protocol.signal({ specVersion: "premise/0.1", eventId: notification.eventId, type: "SourceChanged", occurredAt: notification.occurredAt, payload: { sourceUri: notification.sourceUri, version: notification.version } });
  }

  async reread(memoryIds: readonly string[]): Promise<Awaited<ReturnType<ReferenceProtocol["validate"]>>> {
    const supplied: Record<string, ValidationResult> = {};
    for (const memoryId of memoryIds) {
      const state = this.protocol.states.stateOf(memoryId);
      const source = state?.envelope.provenance?.find((entry) => this.subscriptions.get(entry.sourceUri)?.has(memoryId));
      if (!state || !source) { supplied[memoryId] = { memoryId, result: "UNKNOWN", checkedAt: new Date().toISOString() }; continue; }
      try {
        const current = await this.reader.read(source.sourceUri);
        supplied[memoryId] = { memoryId, result: source.version?.scheme === current.version.scheme && source.version.token === current.version.token ? "UNCHANGED" : "CHANGED", checkedAt: new Date().toISOString(), sourceUri: source.sourceUri, version: current.version };
      } catch {
        supplied[memoryId] = { memoryId, result: "MISSING", checkedAt: new Date().toISOString(), sourceUri: source.sourceUri };
      }
    }
    return this.protocol.validate(memoryIds, supplied);
  }
}
