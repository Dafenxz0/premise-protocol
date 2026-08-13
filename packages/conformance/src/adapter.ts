import {
  assertAdapterCapabilities,
  type AdapterObservation,
  type AdapterRevalidation,
  type PremiseAdapter,
  type PremiseAdapterFeature
} from "@premise/adapter-sdk";

export interface AdapterConformanceOptions<T = unknown> {
  readonly tenantId: string;
  readonly resource: string;
  readonly expectedFeatures?: readonly PremiseAdapterFeature[];
  readonly expectConditionalAction?: boolean;
}

export interface AdapterConformanceCaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface AdapterConformanceReport {
  readonly format: "premise-adapter-conformance/1";
  readonly passed: boolean;
  readonly results: readonly AdapterConformanceCaseResult[];
}

function pass(id: string): AdapterConformanceCaseResult { return Object.freeze({ id, passed: true }); }
function fail(id: string, error: unknown): AdapterConformanceCaseResult {
  return Object.freeze({ id, passed: false, detail: error instanceof Error ? error.message : String(error) });
}

function assertObservation<T>(observation: AdapterObservation<T>, options: AdapterConformanceOptions<T>): void {
  if (observation.tenantId !== options.tenantId) throw new Error("observation tenant does not match request tenant");
  if (observation.resource !== options.resource) throw new Error("observation resource does not match request resource");
  if (observation.version.scheme.length === 0 || observation.version.token.length === 0) throw new Error("observation must include a version");
  if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error("observation observedAt must be an ISO timestamp");
  if (observation.evidence.length === 0) throw new Error("observation must include evidence");
}

/**
 * Runs the adapter checks that are possible without knowing a connector's
 * storage or mutation API. Connector-specific mutation, ABA and authorization
 * scenarios belong in the adapter's own conformance fixture.
 */
export async function runAdapterConformance<T = unknown>(
  adapter: PremiseAdapter<T>,
  options: AdapterConformanceOptions<T>
): Promise<AdapterConformanceReport> {
  const results: AdapterConformanceCaseResult[] = [];
  let observation: AdapterObservation<T> | undefined;
  try {
    const capabilities = assertAdapterCapabilities(adapter, options.expectedFeatures);
    results.push(pass("capabilities"));
    if (options.expectConditionalAction === true && !capabilities.features.includes("CONDITIONAL_ACTION")) throw new Error("conditional action was required but not declared");
  } catch (error) {
    results.push(fail("capabilities", error));
  }
  try {
    observation = await adapter.observe({ tenantId: options.tenantId, resource: options.resource });
    assertObservation(observation, options);
    results.push(pass("initial-observation"));
  } catch (error) {
    results.push(fail("initial-observation", error));
  }
  if (observation !== undefined) {
    let revalidation: AdapterRevalidation | undefined;
    try {
      revalidation = await adapter.revalidate({ tenantId: options.tenantId, record: observation.value, evidence: observation.evidence[0]! });
      if (!["UNCHANGED", "CHANGED", "MISSING", "UNKNOWN"].includes(revalidation.result)) throw new Error("invalid revalidation result");
      if (!Number.isFinite(Date.parse(revalidation.checkedAt))) throw new Error("revalidation checkedAt must be an ISO timestamp");
      results.push(pass("revalidation"));
    } catch (error) {
      results.push(fail("revalidation", error));
    }
    if (options.expectConditionalAction === true) {
      try {
        if (typeof adapter.conditionalAction !== "function") throw new Error("conditionalAction is not implemented");
        const action = await adapter.conditionalAction({ tenantId: options.tenantId, resource: options.resource, expectedVersion: observation.version.token, action: { type: "conformance-noop" } });
        if (typeof action.accepted !== "boolean") throw new Error("conditional action result must include accepted");
        results.push(pass("conditional-action"));
      } catch (error) {
        results.push(fail("conditional-action", error));
      }
    }
  }
  return Object.freeze({ format: "premise-adapter-conformance/1", passed: results.every((result) => result.passed), results: Object.freeze(results) });
}
