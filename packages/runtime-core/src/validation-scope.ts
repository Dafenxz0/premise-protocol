import { createHash } from "node:crypto";

export const PREMISE_VALIDATION_SCOPE_SPEC_VERSION = "premise-validation-scope/1" as const;
export const PREMISE_VALIDATION_SUPERSESSION_SPEC_VERSION = "premise-validation-supersession/1" as const;

/** Complete identity for validation work that may be shared. */
export interface PremiseValidationScope {
  readonly tenantId: string;
  readonly resourceId: string;
  readonly incarnationId: string;
  readonly versionScheme: string;
  readonly versionToken: string;
  readonly validatorId: string;
  readonly authorizationContextDigest: string;
  readonly policyDigest: string;
  readonly queryDigest: string;
  readonly scopes: readonly string[];
  readonly changeSetDigest: string | null;
  readonly causalFrontier: readonly string[];
}

/**
 * Identity that can supersede an in-flight validation for a resource.
 *
 * This is deliberately smaller than PremiseValidationScope. Query, validator,
 * authorization, policy, scopes, change-set and causal-frontier differences
 * select distinct validation work, but do not by themselves prove that the
 * resource changed. Only a new incarnation or version may fence an older
 * validation.
 */
export type PremiseValidationSupersessionScope = Readonly<Pick<
  PremiseValidationScope,
  "tenantId" | "resourceId" | "incarnationId" | "versionScheme" | "versionToken"
>>;

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function canonicalSet(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const values = value.map((item, index) => required(item, `${name}[${index}]`));
  return Object.freeze([...new Set(values)].sort());
}

/** Validates and normalizes the only identity that may be shared. */
export function normalizePremiseValidationScope(scope: PremiseValidationScope): PremiseValidationScope {
  if (scope === null || typeof scope !== "object") throw new TypeError("PREMiSE validation scope is required");
  const value = scope as PremiseValidationScope;
  const changeSetDigest = value.changeSetDigest;
  if (changeSetDigest !== null) required(changeSetDigest, "changeSetDigest");
  return Object.freeze({
    tenantId: required(value.tenantId, "tenantId"),
    resourceId: required(value.resourceId, "resourceId"),
    incarnationId: required(value.incarnationId, "incarnationId"),
    versionScheme: required(value.versionScheme, "versionScheme"),
    versionToken: required(value.versionToken, "versionToken"),
    validatorId: required(value.validatorId, "validatorId"),
    authorizationContextDigest: required(value.authorizationContextDigest, "authorizationContextDigest"),
    policyDigest: required(value.policyDigest, "policyDigest"),
    queryDigest: required(value.queryDigest, "queryDigest"),
    scopes: canonicalSet(value.scopes, "scopes"),
    changeSetDigest,
    causalFrontier: canonicalSet(value.causalFrontier, "causalFrontier")
  });
}

/** Stable canonical representation used by every validation-sharing consumer. */
export function canonicalPremiseValidationScope(scope: PremiseValidationScope): string {
  const normalized = normalizePremiseValidationScope(scope);
  return JSON.stringify({ domain: PREMISE_VALIDATION_SCOPE_SPEC_VERSION, ...normalized });
}

/** Stable key for receipt reuse, in-process flights, and durable flights. */
export function premiseValidationScopeKey(scope: PremiseValidationScope): string {
  return `sha256:${createHash("sha256").update(canonicalPremiseValidationScope(scope), "utf8").digest("hex")}`;
}

/**
 * Stable representation for supersession/fencing, intentionally excluding
 * validation-sharing dimensions that do not establish a new resource version.
 */
export function canonicalPremiseValidationSupersessionScope(scope: PremiseValidationScope): string {
  const normalized = normalizePremiseValidationScope(scope);
  const supersession: PremiseValidationSupersessionScope = {
    tenantId: normalized.tenantId,
    resourceId: normalized.resourceId,
    incarnationId: normalized.incarnationId,
    versionScheme: normalized.versionScheme,
    versionToken: normalized.versionToken
  };
  return JSON.stringify({ domain: PREMISE_VALIDATION_SUPERSESSION_SPEC_VERSION, ...supersession });
}

/** Stable key for the resource-version generation that may fence older work. */
export function premiseValidationSupersessionKey(scope: PremiseValidationScope): string {
  return `sha256:${createHash("sha256").update(canonicalPremiseValidationSupersessionScope(scope), "utf8").digest("hex")}`;
}
