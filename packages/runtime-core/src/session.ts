import type { EvidenceReference } from "@premise/protocol-types";
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

export interface PremiseSessionAdapter<T = unknown> {
  /** Observe one external resource and return a tenant-scoped PREMiSE record. */
  observe(resource: string, context: { readonly tenantId: string }): Promise<RuntimeRecord<T>> | RuntimeRecord<T>;
  /** Create the derived claim and its evidence/dependency envelope. */
  derive(input: PremiseSessionDeriveInput<T> & { readonly tenantId: string }): Promise<RuntimeRecord<T>> | RuntimeRecord<T>;
  /** Revalidate one evidence item without deciding whether the memory is usable. */
  revalidate(evidence: EvidenceReference, record: RuntimeRecord<T>): Promise<RuntimeValidationReport>;
  /** Optional connector-owned conditional action. It must perform the remote CAS. */
  conditionalAction?(input: {
    readonly premise: PremiseSessionPremise<T>;
    readonly action: unknown;
    readonly expectedVersion: string;
  }): Promise<RuntimeActionCommitResult<T>> | RuntimeActionCommitResult<T>;
}

export interface PremiseSessionOptions<T = unknown> {
  readonly tenant: string;
  readonly adapter: PremiseSessionAdapter<T>;
  readonly runtime?: PremiseRuntime<T>;
}

export interface PremiseSessionAction<T = unknown> {
  readonly premise: PremiseSessionPremise<T>;
  readonly action: unknown;
  /** Optional explicit version; otherwise the single evidence version is used. */
  readonly expectedVersion?: string;
}

function required(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function copyRecord<T>(record: RuntimeRecord<T>, tenant: string): RuntimeRecord<T> {
  if (record.envelope.tenantId !== tenant) throw new Error("Adapter returned a record outside the session tenant");
  return record;
}

function evidenceVersion(record: RuntimeRecord<unknown>): string {
  const versions = record.envelope.evidence.map((item) => item.version?.token).filter((token): token is string => typeof token === "string");
  if (versions.length === 0 || versions.some((version) => version !== versions[0])) throw new Error("Action requires one consistent evidence version");
  return versions[0]!;
}

/**
 * Small façade over the runtime. It deliberately owns orchestration only:
 * adapters still own source I/O, authentication and remote conditional writes.
 */
export class PremiseSession<T = unknown> {
  readonly tenant: string;
  readonly adapter: PremiseSessionAdapter<T>;
  readonly runtime: PremiseRuntime<T>;

  constructor(options: PremiseSessionOptions<T>) {
    this.tenant = required(options.tenant, "tenant");
    this.adapter = options.adapter;
    if (this.adapter === undefined || typeof this.adapter.observe !== "function" || typeof this.adapter.derive !== "function" || typeof this.adapter.revalidate !== "function") {
      throw new TypeError("adapter must implement observe, derive and revalidate");
    }
    this.runtime = options.runtime ?? new PremiseRuntime<T>({ tenantId: this.tenant });
    if (this.runtime.tenantId !== this.tenant) throw new Error("Session tenant must match runtime tenant");
  }

  async observe(resource: string): Promise<PremiseSessionPremise<T>> {
    const normalized = required(resource, "resource");
    const record = copyRecord(await this.adapter.observe(normalized, { tenantId: this.tenant }), this.tenant);
    this.runtime.register(record, `session:observe:${normalized}:${record.envelope.memoryId}`);
    return { memoryId: record.envelope.memoryId, record: this.runtime.get(record.envelope.memoryId)! };
  }

  async derive(input: PremiseSessionDeriveInput<T>): Promise<PremiseSessionPremise<T>> {
    if (input === undefined || typeof input.claim !== "string" || input.claim.trim().length === 0) throw new TypeError("claim must be a non-empty string");
    if (!Array.isArray(input.from) || input.from.length === 0) throw new TypeError("from must contain at least one premise");
    const sources = input.from.map((premise) => {
      if (premise === undefined || premise.memoryId.length === 0 || premise.record.envelope.memoryId !== premise.memoryId) throw new TypeError("from contains an invalid premise");
      const current = this.runtime.get(premise.memoryId);
      if (current === undefined) throw new Error(`Premise is not registered in this session: ${premise.memoryId}`);
      return current;
    });
    const record = copyRecord(await this.adapter.derive({ ...input, from: input.from, tenantId: this.tenant }), this.tenant);
    if (!sources.every((source) => record.envelope.dependsOn.includes(source.envelope.memoryId))) throw new Error("Derived record must declare every source premise as a dependency");
    this.runtime.derive(record, `session:derive:${record.envelope.memoryId}`);
    return { memoryId: record.envelope.memoryId, record: this.runtime.get(record.envelope.memoryId)! };
  }

  check(premise: PremiseSessionPremise<T>) {
    return this.runtime.check([premise.memoryId])[0]!;
  }

  async revalidate(premise: PremiseSessionPremise<T>): Promise<RuntimeValidationReport> {
    return this.runtime.revalidate(premise.memoryId, (evidence, record) => this.adapter.revalidate(evidence, record));
  }

  async act(input: PremiseSessionAction<T>): Promise<RuntimeActionResult<T>> {
    if (input === undefined || input.premise === undefined || input.premise.record.envelope.memoryId !== input.premise.memoryId) throw new TypeError("act requires a registered premise");
    if (this.adapter.conditionalAction === undefined) throw new Error("Adapter does not provide a conditionalAction; PREMiSE will not execute an unguarded action");
    const current = this.runtime.get(input.premise.memoryId);
    if (current === undefined) throw new Error(`Premise is not registered in this session: ${input.premise.memoryId}`);
    const expectedVersion = input.expectedVersion ?? evidenceVersion(current);
    return this.runtime.revalidateAndAct(input.premise.memoryId, {
      expectedVersion,
      action: input.action,
      commit: (record, version) => this.adapter.conditionalAction!({ premise: { memoryId: record.envelope.memoryId, record }, action: input.action, expectedVersion: version })
    });
  }
}

export function createPremiseSession<T = unknown>(options: PremiseSessionOptions<T>): PremiseSession<T> {
  return new PremiseSession(options);
}

export const premise = Object.freeze({ session: createPremiseSession });
