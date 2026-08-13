import type { EvidenceReference, VersionReference, V2EventStreamPage, V2StreamCapability } from "@premise/protocol-types";

export type PremiseAdapterFeature =
  | "OBSERVE"
  | "REVALIDATE"
  | "CONDITIONAL_ACTION"
  | "SUBSCRIBE"
  | "AUTHORITATIVE_SNAPSHOT";

export interface PremiseAdapterCapabilities {
  readonly contract: "premise-adapter/1";
  readonly adapterId: string;
  readonly features: readonly PremiseAdapterFeature[];
  readonly streamCapabilities?: readonly V2StreamCapability[];
}

export interface AdapterObserveRequest {
  readonly tenantId: string;
  readonly resource: string;
  readonly signal?: AbortSignal;
}

export interface AdapterObservation<T = unknown> {
  readonly tenantId: string;
  readonly resource: string;
  readonly value: T;
  readonly version: VersionReference;
  readonly observedAt: string;
  readonly evidence: readonly EvidenceReference[];
}

export interface AdapterRevalidateRequest<T = unknown> {
  readonly tenantId: string;
  readonly record: T;
  readonly evidence: EvidenceReference;
  readonly signal?: AbortSignal;
}

export interface AdapterRevalidation {
  readonly result: "UNCHANGED" | "CHANGED" | "MISSING" | "UNKNOWN";
  readonly version?: VersionReference;
  readonly checkedAt: string;
  readonly reason?: string;
}

export interface AdapterConditionalActionRequest<TAction = unknown> {
  readonly tenantId: string;
  readonly resource: string;
  readonly expectedVersion: string;
  readonly action: TAction;
  readonly signal?: AbortSignal;
}

export interface AdapterActionResult<TResult = unknown> {
  readonly accepted: boolean;
  readonly result?: TResult;
  readonly reason?: "VERSION_MISMATCH" | "REJECT" | "UNKNOWN";
  readonly observedVersion?: string;
}

export interface PremiseAdapter<T = unknown, TAction = unknown, TResult = unknown> {
  capabilities(): PremiseAdapterCapabilities;
  observe(request: AdapterObserveRequest): Promise<AdapterObservation<T>>;
  revalidate(request: AdapterRevalidateRequest<T>): Promise<AdapterRevalidation>;
  conditionalAction?(request: AdapterConditionalActionRequest<TAction>): Promise<AdapterActionResult<TResult>>;
  subscribe?(tenantId: string, resource: string, signal?: AbortSignal): AsyncIterable<unknown>;
  authoritativeSnapshot?(tenantId: string, resource: string, signal?: AbortSignal): Promise<V2EventStreamPage>;
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

export function assertAdapterCapabilities(
  adapter: Pick<PremiseAdapter<unknown>, "capabilities">,
  required: readonly PremiseAdapterFeature[] = ["OBSERVE", "REVALIDATE"]
): PremiseAdapterCapabilities {
  const capabilities = adapter.capabilities();
  if (capabilities.contract !== "premise-adapter/1") throw new TypeError("Unsupported PREMiSE adapter contract");
  nonEmpty(capabilities.adapterId, "adapterId");
  const features = new Set(capabilities.features);
  const missing = required.filter((feature) => !features.has(feature));
  if (missing.length > 0) throw new Error(`Adapter lacks required features: ${missing.join(", ")}`);
  return capabilities;
}

export function assertConditionalActionCapability(adapter: Pick<PremiseAdapter<unknown>, "capabilities" | "conditionalAction">): void {
  assertAdapterCapabilities(adapter, ["OBSERVE", "REVALIDATE", "CONDITIONAL_ACTION"]);
  if (typeof adapter.conditionalAction !== "function") throw new TypeError("CONDITIONAL_ACTION is declared but not implemented");
}
