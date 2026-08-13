import {
  parseV2StreamEvent,
  type V2StreamCapability,
  type V2StreamEvent
} from "@premise/protocol-types";

export interface RuntimeStreamBurstCapabilities {
  readonly capabilities: readonly V2StreamCapability[];
}

export type RuntimeStreamBurstPlan =
  | {
      readonly status: "COALESCED";
      readonly streamId: string;
      readonly tenantId: string;
      readonly events: readonly V2StreamEvent[];
      readonly skippedSequences: readonly number[];
    }
  | {
      readonly status: "PRESERVED";
      readonly reason: "EMPTY" | "CAPABILITY_MISSING" | "NO_SNAPSHOT" | "NON_CONTIGUOUS" | "DELTA_CAPABILITY_MISSING" | "NOTHING_TO_SKIP";
      readonly events: readonly V2StreamEvent[];
    };

function has(capabilities: readonly V2StreamCapability[], capability: V2StreamCapability): boolean {
  return capabilities.includes(capability);
}

/**
 * Selects a safe suffix of a connector burst. A prefix may be discarded only
 * when a later event is an adapter-authoritative snapshot and the complete
 * burst is ordered and contiguous. Delta-only bursts are deliberately kept.
 */
export function planRuntimeStreamBurst(
  input: readonly V2StreamEvent[],
  options: RuntimeStreamBurstCapabilities
): RuntimeStreamBurstPlan {
  if (input.length === 0) return Object.freeze({ status: "PRESERVED", reason: "EMPTY", events: Object.freeze([]) });
  const events = input.map((event) => parseV2StreamEvent(event));
  const first = events[0]!;
  for (const event of events) {
    if (event.streamId !== first.streamId || event.tenantId !== first.tenantId) {
      return Object.freeze({ status: "PRESERVED", reason: "NON_CONTIGUOUS", events: Object.freeze(events) });
    }
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence !== events[index - 1]!.sequence + 1) {
      return Object.freeze({ status: "PRESERVED", reason: "NON_CONTIGUOUS", events: Object.freeze(events) });
    }
  }
  if (!has(options.capabilities, "ORDERED_EVENTS") || !has(options.capabilities, "AUTHORITATIVE_SNAPSHOT")) {
    return Object.freeze({ status: "PRESERVED", reason: "CAPABILITY_MISSING", events: Object.freeze(events) });
  }
  let latestSnapshot = -1;
  for (let index = 0; index < events.length; index += 1) if (events[index]!.kind === "SNAPSHOT") latestSnapshot = index;
  if (latestSnapshot < 0) return Object.freeze({ status: "PRESERVED", reason: "NO_SNAPSHOT", events: Object.freeze(events) });
  if (latestSnapshot === 0) return Object.freeze({ status: "PRESERVED", reason: "NOTHING_TO_SKIP", events: Object.freeze(events) });
  if (!has(options.capabilities, "DELTA_EVENTS") && latestSnapshot < events.length - 1) {
    return Object.freeze({ status: "PRESERVED", reason: "DELTA_CAPABILITY_MISSING", events: Object.freeze(events) });
  }
  return Object.freeze({
    status: "COALESCED",
    streamId: first.streamId,
    tenantId: first.tenantId,
    events: Object.freeze(events.slice(latestSnapshot)),
    skippedSequences: Object.freeze(events.slice(0, latestSnapshot).map((event) => event.sequence))
  });
}
