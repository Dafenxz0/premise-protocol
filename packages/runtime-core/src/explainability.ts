import type { VersionReference } from "@premise/protocol-types";

export const EXPLANATION_SPEC_VERSION = "premise-explainability/1" as const;

export type ExplanationDecision = "USE" | "REVALIDATE" | "REJECT";
export type ExplanationState = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";
export type ExplanationRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ExplanationEvidenceInput {
  readonly evidenceId: string;
  readonly tenantId?: string;
  readonly state?: ExplanationState;
  readonly observedAt?: string;
  readonly version?: VersionReference;
}

export interface ExplanationDependencyInput {
  readonly memoryId: string;
  readonly tenantId?: string;
  readonly state: ExplanationState;
  readonly dependsOn?: readonly string[];
  readonly reasonCodes?: readonly string[];
}

/**
 * A receipt is deliberately metadata-shaped. Extra fields are accepted by
 * JavaScript callers but are never copied into an explanation document.
 */
export interface ExplanationReceiptInput {
  readonly tenantId?: string;
  readonly memoryId?: string;
  readonly decision?: ExplanationDecision | "ALLOW" | "ACCEPTED" | "USABLE";
  readonly state?: ExplanationState;
  readonly reason?: string;
  readonly reasonCodes?: readonly string[];
  readonly evidence?: readonly ExplanationEvidenceInput[];
  readonly dependencies?: readonly ExplanationDependencyInput[];
  readonly dependsOn?: readonly string[];
  readonly policy?: string;
  readonly risk?: ExplanationRisk;
  readonly evaluatedAt?: string;
}

export interface ExplanationInput {
  readonly tenantId: string;
  readonly memoryId?: string;
  readonly decision?: ExplanationDecision | "ALLOW" | "ACCEPTED" | "USABLE";
  readonly state?: ExplanationState;
  readonly reasonCodes?: readonly string[];
  readonly evidence?: readonly ExplanationEvidenceInput[];
  readonly dependencies?: readonly ExplanationDependencyInput[];
  readonly dependsOn?: readonly string[];
  readonly policy?: string;
  readonly risk?: ExplanationRisk;
  readonly evaluatedAt?: string;
  readonly receipt?: ExplanationReceiptInput;
}

export interface ExplanationEvidence {
  readonly evidenceId: string;
  readonly state?: ExplanationState;
  readonly observedAt?: string;
  readonly version?: VersionReference;
}

export interface ExplanationDependency {
  readonly memoryId: string;
  readonly state: ExplanationState;
  readonly dependsOn: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface ExplanationCausalDependency {
  readonly from: string;
  readonly to: string;
  readonly relation: "DEPENDS_ON";
}

export interface ExplanationDocument {
  readonly specVersion: typeof EXPLANATION_SPEC_VERSION;
  readonly tenantId: string;
  readonly decision: ExplanationDecision;
  readonly state: ExplanationState;
  readonly reasonCodes: readonly string[];
  readonly evidence: readonly ExplanationEvidence[];
  readonly dependencies: readonly ExplanationDependency[];
  readonly causalDependencies: readonly ExplanationCausalDependency[];
  readonly redaction: "PAYLOADS_OMITTED";
  readonly memoryId?: string;
  readonly policy?: string;
  readonly risk?: ExplanationRisk;
  readonly evaluatedAt?: string;
}

const states = new Set<ExplanationState>(["FRESH", "STALE", "INVALID", "UNKNOWN"]);
const risks = new Set<ExplanationRisk>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const reasonCodePattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function state(value: unknown, name: string): ExplanationState {
  if (typeof value !== "string" || !states.has(value as ExplanationState)) throw new TypeError(`${name} must be a PREMiSE state`);
  return value as ExplanationState;
}

function risk(value: unknown, name: string): ExplanationRisk {
  if (typeof value !== "string" || !risks.has(value as ExplanationRisk)) throw new TypeError(`${name} must be a PREMiSE risk level`);
  return value as ExplanationRisk;
}

function timestamp(value: unknown, name: string): string {
  const text = requiredString(value, name);
  if (Number.isNaN(Date.parse(text))) throw new TypeError(`${name} must be a valid timestamp`);
  return text;
}

function version(value: unknown, name: string): VersionReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${name} must be a version reference`);
  const candidate = value as { scheme?: unknown; token?: unknown };
  return Object.freeze({
    scheme: requiredString(candidate.scheme, `${name}.scheme`),
    token: requiredString(candidate.token, `${name}.token`)
  });
}

function ids(values: readonly string[] | undefined, name: string): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new TypeError(`${name} must be an array`);
  const normalized = values.map((value, index) => requiredString(value, `${name}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${name} must not contain duplicates`);
  return Object.freeze([...normalized].sort((left, right) => left.localeCompare(right)));
}

function reasonCodes(values: readonly string[] | undefined, name: string): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new TypeError(`${name} must be an array`);
  const normalized = values.map((value, index) => {
    const code = requiredString(value, `${name}[${index}]`);
    if (!reasonCodePattern.test(code)) throw new TypeError(`${name}[${index}] must be a non-sensitive reason code`);
    return code;
  });
  return Object.freeze([...new Set(normalized)].sort((left, right) => left.localeCompare(right)));
}

function decision(value: unknown, name: string): ExplanationDecision {
  if (value === "USE" || value === "USABLE" || value === "ALLOW" || value === "ACCEPTED") return "USE";
  if (value === "REVALIDATE" || value === "REJECT") return value;
  throw new TypeError(`${name} must be USE, REVALIDATE or REJECT`);
}

function sameOrUndefined<T>(outer: T | undefined, receipt: T | undefined, name: string): T | undefined {
  if (outer !== undefined && receipt !== undefined && outer !== receipt) throw new TypeError(`${name} conflicts with receipt.${name}`);
  return outer ?? receipt;
}

function metadata<T>(outer: readonly T[] | undefined, receipt: readonly T[] | undefined): readonly T[] {
  return outer ?? receipt ?? [];
}

function normalizeEvidence(values: readonly ExplanationEvidenceInput[]): readonly ExplanationEvidence[] {
  const output = values.map((item, index) => {
    if (item === undefined || typeof item !== "object") throw new TypeError(`evidence[${index}] must be an object`);
    const evidence = item as ExplanationEvidenceInput;
    const evidenceId = requiredString(evidence.evidenceId, `evidence[${index}].evidenceId`);
    if (evidence.tenantId !== undefined) requiredString(evidence.tenantId, `evidence[${index}].tenantId`);
    const normalizedState = evidence.state === undefined ? undefined : state(evidence.state, `evidence[${index}].state`);
    const observedAt = evidence.observedAt === undefined ? undefined : timestamp(evidence.observedAt, `evidence[${index}].observedAt`);
    const normalizedVersion = evidence.version === undefined ? undefined : version(evidence.version, `evidence[${index}].version`);
    return Object.freeze({
      evidenceId,
      ...(normalizedState === undefined ? {} : { state: normalizedState }),
      ...(observedAt === undefined ? {} : { observedAt }),
      ...(normalizedVersion === undefined ? {} : { version: normalizedVersion })
    });
  });
  if (new Set(output.map((item) => item.evidenceId)).size !== output.length) throw new TypeError("evidence must not contain duplicate IDs");
  return Object.freeze(output.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)));
}

function normalizeDependencies(values: readonly ExplanationDependencyInput[]): readonly ExplanationDependency[] {
  const output = values.map((item, index) => {
    if (item === undefined || typeof item !== "object") throw new TypeError(`dependencies[${index}] must be an object`);
    const dependency = item as ExplanationDependencyInput;
    const memoryId = requiredString(dependency.memoryId, `dependencies[${index}].memoryId`);
    if (dependency.tenantId !== undefined) requiredString(dependency.tenantId, `dependencies[${index}].tenantId`);
    return Object.freeze({
      memoryId,
      state: state(dependency.state, `dependencies[${index}].state`),
      dependsOn: ids(dependency.dependsOn, `dependencies[${index}].dependsOn`),
      reasonCodes: reasonCodes(dependency.reasonCodes, `dependencies[${index}].reasonCodes`)
    });
  });
  if (new Set(output.map((item) => item.memoryId)).size !== output.length) throw new TypeError("dependencies must not contain duplicate memory IDs");
  return Object.freeze(output.sort((left, right) => left.memoryId.localeCompare(right.memoryId)));
}

function causalDependencies(memoryId: string | undefined, rootDependsOn: readonly string[], dependencies: readonly ExplanationDependency[]): readonly ExplanationCausalDependency[] {
  const edges = [
    ...(memoryId === undefined ? [] : rootDependsOn.map((from) => ({ from, to: memoryId, relation: "DEPENDS_ON" as const }))),
    ...dependencies.flatMap((dependency) => dependency.dependsOn.map((from) => ({ from, to: dependency.memoryId, relation: "DEPENDS_ON" as const })))
  ];
  const unique = new Map(edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge]));
  return Object.freeze([...unique.values()].sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)));
}

function derivedReasonCodes(currentState: ExplanationState, dependencies: readonly ExplanationDependency[]): readonly string[] {
  const derived = currentState === "UNKNOWN" ? ["STATE_UNKNOWN"] : [];
  const dependencyStates = new Set(dependencies.map((dependency) => dependency.state));
  for (const dependencyState of ["INVALID", "UNKNOWN", "STALE"] as const) {
    if (dependencyStates.has(dependencyState)) derived.push(`DEPENDENCY_${dependencyState}`);
  }
  return derived;
}

/**
 * Produces a stable, metadata-only explanation. This function does not
 * recalculate policy and never treats an explanation as authorization.
 */
export function createExplanationDocument(input: ExplanationInput): ExplanationDocument {
  if (input === undefined || typeof input !== "object") throw new TypeError("explanation input must be an object");
  const tenantId = requiredString(input.tenantId, "tenantId");
  const receipt = input.receipt;
  if (receipt !== undefined && (typeof receipt !== "object" || receipt === null || Array.isArray(receipt))) throw new TypeError("receipt must be an object");
  if (receipt?.tenantId !== undefined && requiredString(receipt.tenantId, "receipt.tenantId") !== tenantId) throw new Error("Explanation tenant scope violation");

  const memoryId = sameOrUndefined(
    optionalString(input.memoryId, "memoryId"),
    receipt?.memoryId === undefined ? undefined : requiredString(receipt.memoryId, "receipt.memoryId"),
    "memoryId"
  );
  const rawDecision = sameOrUndefined(input.decision, receipt?.decision, "decision");
  const rawState = sameOrUndefined(input.state, receipt?.state, "state");
  if (rawDecision === undefined) throw new TypeError("decision is required");
  if (rawState === undefined) throw new TypeError("state is required");
  const normalizedDecision = decision(rawDecision, "decision");
  const normalizedState = state(rawState, "state");

  const rawEvidence = metadata(input.evidence, receipt?.evidence);
  const rawDependencies = metadata(input.dependencies, receipt?.dependencies);
  const evidence = normalizeEvidence(rawEvidence);
  const dependencies = normalizeDependencies(rawDependencies);
  for (const item of rawEvidence) {
    if (item.tenantId !== undefined && requiredString(item.tenantId, "evidence.tenantId") !== tenantId) throw new Error("Explanation tenant scope violation");
  }
  for (const item of rawDependencies) {
    if (item.tenantId !== undefined && requiredString(item.tenantId, "dependency.tenantId") !== tenantId) throw new Error("Explanation tenant scope violation");
  }

  const rootDependsOn = ids(input.dependsOn ?? receipt?.dependsOn, "dependsOn");
  const normalizedPolicy = sameOrUndefined(
    optionalString(input.policy, "policy"),
    receipt?.policy === undefined ? undefined : requiredString(receipt.policy, "receipt.policy"),
    "policy"
  );
  const rawRisk = sameOrUndefined(input.risk, receipt?.risk, "risk");
  const normalizedRisk = rawRisk === undefined ? undefined : risk(rawRisk, "risk");
  const evaluatedAt = sameOrUndefined(
    input.evaluatedAt === undefined ? undefined : timestamp(input.evaluatedAt, "evaluatedAt"),
    receipt?.evaluatedAt === undefined ? undefined : timestamp(receipt.evaluatedAt, "receipt.evaluatedAt"),
    "evaluatedAt"
  );
  const suppliedReasonCodes = [
    ...reasonCodes(input.reasonCodes, "reasonCodes"),
    ...reasonCodes(receipt?.reasonCodes, "receipt.reasonCodes"),
    ...(receipt?.reason !== undefined && reasonCodePattern.test(receipt.reason) ? [receipt.reason] : [])
  ];
  const finalReasonCodes = Object.freeze([...new Set([...suppliedReasonCodes, ...derivedReasonCodes(normalizedState, dependencies)])]
    .sort((left, right) => left.localeCompare(right)));
  const causal = causalDependencies(memoryId, rootDependsOn, dependencies);

  return Object.freeze({
    specVersion: EXPLANATION_SPEC_VERSION,
    tenantId,
    decision: normalizedDecision,
    state: normalizedState,
    reasonCodes: finalReasonCodes,
    evidence,
    dependencies,
    causalDependencies: causal,
    redaction: "PAYLOADS_OMITTED",
    ...(memoryId === undefined ? {} : { memoryId }),
    ...(normalizedPolicy === undefined ? {} : { policy: normalizedPolicy }),
    ...(normalizedRisk === undefined ? {} : { risk: normalizedRisk }),
    ...(evaluatedAt === undefined ? {} : { evaluatedAt })
  });
}

export const explainDecision = createExplanationDocument;
