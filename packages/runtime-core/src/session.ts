import { createHash } from "node:crypto";
import {
  SPEC_VERSION_V2,
  type EvidenceReference,
  type VersionReference,
} from "@premise/protocol-types";
import type {
  AdapterActionResult,
  AdapterConditionalActionRequest,
  AdapterObservation,
  AdapterRevalidation,
  AdapterRevalidateRequest,
  AdapterObserveRequest,
  PremiseAdapter,
  PremiseAdapterCapabilities,
  PremiseAdapterFeature,
} from "@premise/adapter-sdk";
import type {
  RuntimeActionCommitResult,
  RuntimeActionResult,
  RuntimeRecord,
  RuntimeValidationReport,
} from "./index.js";
import { PremiseRuntime } from "./index.js";

export interface PremiseSessionPremise<T = unknown> {
  readonly memoryId: string;
  readonly record: RuntimeRecord<T>;
}

export interface PremiseSessionDeriveInput<T = unknown> {
  readonly claim: string;
  readonly from: readonly PremiseSessionPremise<T>[];
}

export type PremiseSessionAdapterFeature = PremiseAdapterFeature;
export type PremiseSessionAdapterCapabilities = PremiseAdapterCapabilities;
export type PremiseSessionObserveRequest = AdapterObserveRequest;

export interface PremiseSessionObservation<T = unknown> extends AdapterObservation<T> {
  /** Optional stable ID; Session derives one from the tenant and resource when absent. */
  readonly memoryId?: string;
}

export type PremiseSessionRevalidateRequest<T = unknown> = AdapterRevalidateRequest<T>;
export type PremiseSessionAdapterRevalidation = AdapterRevalidation;
export type PremiseSessionConditionalActionRequest<TAction = unknown> = AdapterConditionalActionRequest<TAction>;
export type PremiseSessionAdapterActionResult<TResult = unknown> = AdapterActionResult<TResult>;

/**
 * The external adapter contract. Adapters observe and revalidate external
 * state, and may own a conditional write; Session owns derivation.
 */
export interface PremiseSessionAdapter<T = unknown, TAction = unknown, TResult = unknown>
  extends Omit<PremiseAdapter<T, TAction, TResult>, "capabilities"> {
  readonly capabilities?: () => PremiseSessionAdapterCapabilities;
}

/** The canonical SDK adapter type accepted directly by `PremiseSession`. */
export type PremiseSessionSdkAdapter<T = unknown, TAction = unknown, TResult = unknown> = PremiseAdapter<T, TAction, TResult>;

/** @deprecated Runtime-record adapters remain accepted, but Session no longer calls `derive` on them. */
export interface LegacyPremiseSessionAdapter<T = unknown, TAction = unknown> {
  observe(resource: string, context: { readonly tenantId: string }): Promise<RuntimeRecord<T>> | RuntimeRecord<T>;
  revalidate(evidence: EvidenceReference, record: RuntimeRecord<T>): Promise<RuntimeValidationReport>;
  conditionalAction?(input: {
    readonly premise: PremiseSessionPremise<T>;
    readonly action: TAction;
    readonly expectedVersion: VersionReference;
  }): Promise<RuntimeActionCommitResult<T>> | RuntimeActionCommitResult<T>;
  /** @deprecated Ignored; derive is owned by PremiseSession. */
  derive?(input: PremiseSessionDeriveInput<T> & { readonly tenantId: string }): Promise<RuntimeRecord<T>> | RuntimeRecord<T>;
}

type PremiseSessionCompatibleAdapter<T, TAction, TResult> =
  | PremiseSessionAdapter<T, TAction, TResult>
  | LegacyPremiseSessionAdapter<T, TAction>;

export interface PremiseSessionOptions<T = unknown, TAction = unknown, TResult = unknown> {
  readonly tenant: string;
  readonly adapter: PremiseSessionCompatibleAdapter<T, TAction, TResult>;
  readonly runtime?: PremiseRuntime<T>;
}

export interface PremiseSessionAction<T = unknown, TAction = unknown> {
  readonly premise: PremiseSessionPremise<T>;
  readonly action: TAction;
  /** Resource to mutate; defaults to the first evidence source. */
  readonly resource?: string;
  /** Optional explicit version; otherwise the single evidence version is used. */
  readonly expectedVersion?: VersionReference;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionMemoryId(kind: string, ...parts: readonly string[]): string {
  return `${kind}:${digest(parts.join("\u0000"))}`;
}

function versionReference(value: unknown, name: string): VersionReference {
  if (value === null || typeof value !== "object") throw new TypeError(`${name} must include a version`);
  const version = value as { readonly scheme?: unknown; readonly token?: unknown };
  return { scheme: required(version.scheme, `${name}.scheme`), token: required(version.token, `${name}.token`) };
}

function copyRecord<T>(record: RuntimeRecord<T>, tenant: string): RuntimeRecord<T> {
  if (record === undefined || record.envelope === undefined || record.envelope.tenantId !== tenant) throw new Error("Adapter returned a record outside the session tenant");
  return record;
}

function sameResource(left: string, right: string): boolean {
  return left === right;
}

function observationRecord<T>(observation: PremiseSessionObservation<T>, tenant: string, requestedResource: string): RuntimeRecord<T> {
  if (observation === undefined || observation.tenantId !== tenant) throw new Error("Adapter returned an observation outside the session tenant");
  const resource = required(observation.resource, "observation.resource");
  if (!sameResource(resource, requestedResource)) throw new Error("Adapter returned an observation for a different resource");
  const observedAt = required(observation.observedAt, "observation.observedAt");
  const version = versionReference(observation.version, "observation.version");
  if (!Array.isArray(observation.evidence) || observation.evidence.length === 0) throw new TypeError("Adapter observation must include evidence");
  const evidence = observation.evidence.map((item, index) => index === 0 && item.version === undefined ? { ...item, version } : item);
  const memoryId = observation.memoryId === undefined
    ? sessionMemoryId("session:observation", tenant, resource, version.scheme, version.token)
    : required(observation.memoryId, "observation.memoryId");
  return {
    envelope: {
      specVersion: SPEC_VERSION_V2,
      tenantId: tenant,
      memoryId,
      evidence,
      confidence: { score: null, method: "adapter-observation", assessedAt: observedAt },
      conflicts: [],
      temporal: { asOf: observedAt },
      validity: { status: "FRESH", policy: "VERSIONED", checkedAt: observedAt },
      dependsOn: [],
      signatures: []
    },
    content: observation.value
  };
}

function evidenceVersion(record: RuntimeRecord<unknown>): VersionReference {
  const versions = record.envelope.evidence.map((item) => item.version).filter((version): version is VersionReference => version !== undefined);
  if (versions.length === 0 || versions.some((version) => version.scheme !== versions[0]!.scheme || version.token !== versions[0]!.token)) throw new Error("Action requires one consistent evidence version");
  return versions[0]!;
}

function matchesEvidenceVersion(record: RuntimeRecord<unknown>, expected: VersionReference): boolean {
  return record.envelope.evidence.length > 0
    && record.envelope.evidence.every((evidence) => evidence.version?.scheme === expected.scheme && evidence.version?.token === expected.token);
}

function derivedRecord<T>(tenant: string, input: PremiseSessionDeriveInput<T>, sources: readonly RuntimeRecord<T>[]): RuntimeRecord<T> {
  const dependsOn = [...new Set(sources.map((source) => source.envelope.memoryId))];
  const evidence = [...new Map(sources.flatMap((source) => source.envelope.evidence).map((item) => [item.evidenceId, item])).values()];
  const asOf = sources.map((source) => source.envelope.temporal.asOf).sort().at(-1)!;
  return {
    envelope: {
      specVersion: SPEC_VERSION_V2,
      tenantId: tenant,
      memoryId: sessionMemoryId("session:derived", tenant, input.claim, ...dependsOn),
      evidence,
      confidence: { score: null, method: "session-derive", assessedAt: asOf },
      conflicts: [],
      temporal: { asOf },
      validity: { status: "FRESH", policy: "MANUAL", checkedAt: asOf },
      dependsOn,
      signatures: []
    },
    content: input.claim as T
  };
}

function isLegacyAdapter<T, TAction, TResult>(adapter: PremiseSessionCompatibleAdapter<T, TAction, TResult>): adapter is LegacyPremiseSessionAdapter<T, TAction> {
  return typeof ("capabilities" in adapter ? adapter.capabilities : undefined) !== "function" && typeof (adapter as LegacyPremiseSessionAdapter<T, TAction>).derive === "function";
}

function validationReport<T>(
  result: PremiseSessionAdapterRevalidation,
  evidence: EvidenceReference,
  record: RuntimeRecord<T>
): RuntimeValidationReport {
  const normalizedResult: RuntimeValidationReport["result"] = result.result === "PRECONDITION_FAILED" ? "UNKNOWN" : result.result;
  return {
    memoryId: record.envelope.memoryId,
    result: normalizedResult,
    status: normalizedResult === "UNCHANGED" ? "FRESH" : normalizedResult === "UNKNOWN" ? "UNKNOWN" : "INVALID",
    checkedAt: required(result.checkedAt, "revalidation.checkedAt"),
    sourceUri: evidence.sourceUri,
    evidenceId: evidence.evidenceId,
    ...(result.version === undefined ? {} : { version: result.version }),
    ...(result.reason === undefined && result.result !== "PRECONDITION_FAILED" ? {} : { reason: result.reason ?? "Adapter precondition failed" })
  };
}

function actionCommit<TResult>(result: PremiseSessionAdapterActionResult<TResult>): RuntimeActionCommitResult<TResult> {
  if (result === undefined || typeof result.accepted !== "boolean") throw new TypeError("Adapter conditional action must return an accepted boolean");
  return {
    accepted: result.accepted,
    ...(result.reason === undefined ? {} : { reason: result.reason === "UNKNOWN" ? "REVALIDATE" : result.reason }),
    ...(result.observedVersion === undefined ? {} : { observedVersion: result.observedVersion.token }),
    ...(result.result === undefined ? {} : { result: result.result })
  };
}

/**
 * Small façade over the runtime. It owns orchestration and derivation while
 * adapters retain source I/O, authentication and remote conditional writes.
 */
export class PremiseSession<T = unknown, TAction = unknown, TResult = unknown> {
  readonly tenant: string;
  readonly adapter: PremiseSessionCompatibleAdapter<T, TAction, TResult>;
  readonly runtime: PremiseRuntime<T>;

  constructor(options: PremiseSessionOptions<T, TAction, TResult>) {
    this.tenant = required(options.tenant, "tenant");
    this.adapter = options.adapter;
    if (this.adapter === undefined || typeof this.adapter.observe !== "function" || typeof this.adapter.revalidate !== "function") {
      throw new TypeError("adapter must implement observe and revalidate");
    }
    this.runtime = options.runtime ?? new PremiseRuntime<T>({ tenantId: this.tenant });
    if (this.runtime.tenantId !== this.tenant) throw new Error("Session tenant must match runtime tenant");
  }

  async observe(resource: string): Promise<PremiseSessionPremise<T>> {
    const normalized = required(resource, "resource");
    const record = isLegacyAdapter(this.adapter)
      ? copyRecord(await this.adapter.observe(normalized, { tenantId: this.tenant }), this.tenant)
      : observationRecord(await this.adapter.observe({ tenantId: this.tenant, resource: normalized }), this.tenant, normalized);
    const existing = this.runtime.get(record.envelope.memoryId);
    if (existing !== undefined) return { memoryId: existing.envelope.memoryId, record: existing };
    this.runtime.register(record, `session:observe:${normalized}:${record.envelope.memoryId}`);
    return { memoryId: record.envelope.memoryId, record: this.runtime.get(record.envelope.memoryId)! };
  }

  async derive(input: PremiseSessionDeriveInput<T>): Promise<PremiseSessionPremise<T>> {
    if (input === undefined || typeof input.claim !== "string" || input.claim.trim().length === 0) throw new TypeError("claim must be a non-empty string");
    if (!Array.isArray(input.from) || input.from.length === 0) throw new TypeError("from must contain at least one premise");
    const sources = input.from.map((premise) => {
      if (premise === undefined || typeof premise.memoryId !== "string" || premise.memoryId.length === 0 || premise.record?.envelope.memoryId !== premise.memoryId) throw new TypeError("from contains an invalid premise");
      const current = this.runtime.get(premise.memoryId);
      if (current === undefined) throw new Error(`Premise is not registered in this session: ${premise.memoryId}`);
      return current;
    });
    const record = derivedRecord(this.tenant, input, sources);
    this.runtime.derive(record, `session:derive:${record.envelope.memoryId}`);
    return { memoryId: record.envelope.memoryId, record: this.runtime.get(record.envelope.memoryId)! };
  }

  check(premise: PremiseSessionPremise<T>) {
    return this.runtime.check([premise.memoryId])[0]!;
  }

  async revalidate(premise: PremiseSessionPremise<T>): Promise<RuntimeValidationReport> {
    const adapter = this.adapter;
    return this.runtime.revalidate(premise.memoryId, (evidence, record) => isLegacyAdapter(adapter)
      ? adapter.revalidate(evidence, record)
      : adapter.revalidate({ tenantId: this.tenant, resource: evidence.sourceUri, record: record.content, evidence, ...(evidence.version === undefined ? {} : { expectedVersion: evidence.version }) }).then((result) => validationReport(result, evidence, record)));
  }

  async act(input: PremiseSessionAction<T, TAction>): Promise<RuntimeActionResult<TResult>> {
    if (input === undefined || input.premise === undefined || input.premise.record.envelope.memoryId !== input.premise.memoryId) throw new TypeError("act requires a registered premise");
    if (typeof this.adapter.conditionalAction !== "function") throw new Error("Adapter does not provide a conditionalAction; PREMiSE will not execute an unguarded action");
    const current = this.runtime.get(input.premise.memoryId);
    if (current === undefined) throw new Error(`Premise is not registered in this session: ${input.premise.memoryId}`);
    const expectedVersion = input.expectedVersion ?? evidenceVersion(current);
    if (!matchesEvidenceVersion(current, expectedVersion)) return { accepted: false, memoryId: current.envelope.memoryId, expectedVersion: expectedVersion.token, reason: "VERSION_MISMATCH" } as unknown as RuntimeActionResult<TResult>;
    const resource = input.resource === undefined ? current.envelope.evidence[0]?.sourceUri : required(input.resource, "resource");
    if (resource === undefined || !current.envelope.evidence.some((evidence) => sameResource(evidence.sourceUri, resource))) throw new Error("Action resource must be present in the premise evidence");
    const result = await this.runtime.revalidateAndAct(input.premise.memoryId, {
      expectedVersion: expectedVersion.token,
      action: input.action,
      commit: (record, version) => isLegacyAdapter(this.adapter)
        ? this.adapter.conditionalAction!({ premise: { memoryId: record.envelope.memoryId, record }, action: input.action, expectedVersion: { scheme: expectedVersion.scheme, token: version } })
        : this.adapter.conditionalAction!({ tenantId: this.tenant, resource, expectedVersion: { scheme: expectedVersion.scheme, token: version }, action: input.action }).then((action) => actionCommit(action) as unknown as RuntimeActionCommitResult<T>)
    });
    return result as unknown as RuntimeActionResult<TResult>;
  }
}

export function createPremiseSession<T = unknown, TAction = unknown, TResult = unknown>(options: PremiseSessionOptions<T, TAction, TResult>): PremiseSession<T, TAction, TResult> {
  return new PremiseSession(options);
}

export const premise = Object.freeze({ session: createPremiseSession });
