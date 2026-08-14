import { createHash } from "node:crypto";

export const PREDICATE_DEPENDENCY_SPEC_VERSION = "premise-predicate/1" as const;
export type PredicateOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "exists";
export type PredicateEvaluation = true | false | "UNKNOWN";
export type PredicateChange = "PRESERVED" | "INVALIDATED" | "UNKNOWN";

export interface Predicate {
  readonly operator: PredicateOperator;
  readonly value?: unknown;
}

export interface PredicateDependency {
  readonly specVersion: typeof PREDICATE_DEPENDENCY_SPEC_VERSION;
  readonly tenantId: string;
  readonly resourceId: string;
  readonly incarnationId: string;
  readonly aspect: string;
  readonly predicate: Predicate;
  readonly semanticFingerprint: string;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  throw new TypeError("predicate values must be JSON serializable");
}

function validPredicate(predicate: Predicate): void {
  if (predicate === undefined || typeof predicate !== "object" || !["eq", "neq", "gt", "gte", "lt", "lte", "in", "exists"].includes(predicate.operator)) throw new TypeError("unsupported predicate operator");
  if (predicate.operator === "in" && (!Array.isArray(predicate.value) || predicate.value.length === 0)) throw new TypeError("in predicate requires a non-empty array");
  if (predicate.operator === "exists" && predicate.value !== undefined && typeof predicate.value !== "boolean") throw new TypeError("exists predicate value must be boolean");
  canonical(predicate.value);
}

export function predicateSemanticFingerprint(input: Omit<PredicateDependency, "specVersion" | "semanticFingerprint">): string {
  required(input.tenantId, "tenantId");
  required(input.resourceId, "resourceId");
  required(input.incarnationId, "incarnationId");
  required(input.aspect, "aspect");
  validPredicate(input.predicate);
  const identity = {
    tenantId: input.tenantId,
    resourceId: input.resourceId,
    incarnationId: input.incarnationId,
    aspect: input.aspect,
    predicate: input.predicate
  };
  return `sha256:${createHash("sha256").update(canonical({ domain: PREDICATE_DEPENDENCY_SPEC_VERSION, ...identity }), "utf8").digest("hex")}`;
}

export function createPredicateDependency(input: Omit<PredicateDependency, "specVersion" | "semanticFingerprint">): PredicateDependency {
  const semanticFingerprint = predicateSemanticFingerprint(input);
  return Object.freeze({ ...input, specVersion: PREDICATE_DEPENDENCY_SPEC_VERSION, semanticFingerprint });
}

export function evaluatePredicate(value: unknown, predicate: Predicate): PredicateEvaluation {
  try { validPredicate(predicate); } catch { return "UNKNOWN"; }
  switch (predicate.operator) {
    case "exists": return (value !== undefined && value !== null) === (predicate.value ?? true);
    case "eq": return Object.is(value, predicate.value);
    case "neq": return !Object.is(value, predicate.value);
    case "in": return (predicate.value as readonly unknown[]).some((candidate) => Object.is(candidate, value));
    case "gt": case "gte": case "lt": case "lte": {
      if ((typeof value !== "number" && typeof value !== "string") || (typeof predicate.value !== typeof value)) return "UNKNOWN";
      if (predicate.operator === "gt") return value > (predicate.value as typeof value);
      if (predicate.operator === "gte") return value >= (predicate.value as typeof value);
      if (predicate.operator === "lt") return value < (predicate.value as typeof value);
      return value <= (predicate.value as typeof value);
    }
  }
}

/** Classifies a version change without assuming that every version change invalidates every claim. */
export function classifyPredicateChange(dependency: PredicateDependency, previousValue: unknown, currentValue: unknown): PredicateChange {
  if (dependency.semanticFingerprint !== predicateSemanticFingerprint(dependency)) return "UNKNOWN";
  const previous = evaluatePredicate(previousValue, dependency.predicate);
  if (previous !== true) return "UNKNOWN";
  const current = evaluatePredicate(currentValue, dependency.predicate);
  return current === true ? "PRESERVED" : current === false ? "INVALIDATED" : "UNKNOWN";
}
