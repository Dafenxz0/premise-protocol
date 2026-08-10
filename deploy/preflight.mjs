#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMMUTABLE_IMAGE = /^.+@sha256:[0-9a-f]{64}$/iu;
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;
const PLACEHOLDER = /^__[^\s]+__$/u;
const MUTABLE_TAG = /(?:^|:)(latest|stable|current|previous|local)$/iu;
const INSECURE_VALUE = /(local-only|not-for-production|change[-_ ]?me|changeme|example-secret)/iu;

function configured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function realValue(value) {
  return configured(value) && !PLACEHOLDER.test(value.trim()) && !INSECURE_VALUE.test(value);
}

function parseInteger(value, name, minimum, maximum, errors) {
  if (!configured(value) || !/^\d+$/u.test(value.trim())) {
    errors.push(`${name} must be an integer from ${minimum} to ${maximum}`);
    return undefined;
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) errors.push(`${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

function checkUrl(value, name, errors) {
  if (!realValue(value)) {
    errors.push(`${name} must be injected and must not contain a placeholder`);
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) throw new Error("must use postgres:// or postgresql://");
    if (parsed.username.length === 0) throw new Error("must include a database role");
    return parsed;
  } catch (error) {
    errors.push(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function checkImage(value, name, productionLike, errors, warnings) {
  if (!configured(value)) {
    if (productionLike) errors.push(`${name} must be set to an immutable image reference`);
    else warnings.push(`${name} is omitted; Compose will use its local development default`);
    return;
  }
  const reference = value.trim();
  if (PLACEHOLDER.test(reference)) {
    errors.push(`${name} still contains a placeholder`);
    return;
  }
  if (productionLike && !IMMUTABLE_IMAGE.test(reference)) errors.push(`${name} must include an image digest (@sha256:...) for reproducible deployment`);
  if (!productionLike && MUTABLE_TAG.test(reference)) warnings.push(`${name} uses a mutable/local tag; pin it before staging or production`);
}

function checkSecretToken(value, name, productionLike, errors) {
  if (productionLike && !realValue(value)) errors.push(`${name} must be injected at runtime and must not be a placeholder`);
  if (configured(value) && value.trim().length < 24) errors.push(`${name} must contain at least 24 characters`);
}

function checkTokenFile(value, errors) {
  if (!realValue(value)) {
    errors.push("PREMISE_METRICS_TOKEN_FILE must identify the mounted secret source file");
    return;
  }
  const file = value.trim();
  if (!isAbsolute(file)) errors.push("PREMISE_METRICS_TOKEN_FILE must be an absolute host path for Compose deployments");
  if (isAbsolute(file) && !existsSync(file)) errors.push("PREMISE_METRICS_TOKEN_FILE does not exist on this host");
  if (isAbsolute(file) && existsSync(file) && !statSync(file).isFile()) errors.push("PREMISE_METRICS_TOKEN_FILE must point to a regular file");
}

/**
 * Validate deployment inputs without contacting Docker, PostgreSQL, cloud APIs,
 * KMS, or a monitoring service. A green result means the local configuration is
 * internally safe to hand to the deployment tool; it is not availability proof.
 */
export function validateDeploymentEnvironment(input = process.env) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const environment = String(input.PREMISE_ENV ?? "development").trim().toLowerCase();
  const productionLike = environment === "production" || environment === "staging";
  const check = (id, ok, detail) => checks.push({ id, ok, ...(detail === undefined ? {} : { detail }) });

  check("environment-known", new Set(["development", "staging", "production"]).has(environment), environment);
  if (!new Set(["development", "staging", "production"]).has(environment)) errors.push("PREMISE_ENV must be development, staging, or production");

  const tenantId = input.PREMISE_TENANT_ID ?? "tenant:local";
  check("tenant-configured", configured(tenantId), "tenant identifier present");
  if (!configured(tenantId) || tenantId.trim() !== tenantId) errors.push("PREMISE_TENANT_ID must be a non-empty value without surrounding whitespace");

  const tablePrefix = input.PREMISE_TABLE_PREFIX ?? "premise_v2";
  check("table-prefix-safe", SQL_IDENTIFIER.test(tablePrefix), "lowercase SQL identifier");
  if (!SQL_IDENTIFIER.test(tablePrefix)) errors.push("PREMISE_TABLE_PREFIX must be a lowercase SQL identifier");

  const apiToken = input.PREMISE_API_TOKEN;
  const metricsToken = input.PREMISE_METRICS_TOKEN;
  checkSecretToken(apiToken, "PREMISE_API_TOKEN", productionLike, errors);
  checkSecretToken(metricsToken, "PREMISE_METRICS_TOKEN", productionLike, errors);
  check("operational-tokens-distinct", !configured(apiToken) || !configured(metricsToken) || apiToken !== metricsToken, "API and metrics credentials must not be reused");
  if (configured(apiToken) && configured(metricsToken) && apiToken === metricsToken) errors.push("PREMISE_API_TOKEN and PREMISE_METRICS_TOKEN must be different");
  if (productionLike) checkTokenFile(input.PREMISE_METRICS_TOKEN_FILE, errors);

  const applicationUrl = checkUrl(input.DATABASE_URL, "DATABASE_URL", productionLike ? errors : []);
  const migrationUrl = checkUrl(input.MIGRATIONS_DATABASE_URL, "MIGRATIONS_DATABASE_URL", productionLike ? errors : []);
  check("application-database-configured", applicationUrl !== undefined || !productionLike, "application URL present");
  check("migration-database-configured", migrationUrl !== undefined || !productionLike, "migration URL present");
  if (applicationUrl !== undefined && migrationUrl !== undefined && applicationUrl.username === migrationUrl.username) errors.push("DATABASE_URL and MIGRATIONS_DATABASE_URL must use different database roles");

  checkImage(input.PREMISE_IMAGE, "PREMISE_IMAGE", productionLike, errors, warnings);
  checkImage(input.PREMISE_POSTGRES_IMAGE, "PREMISE_POSTGRES_IMAGE", productionLike, errors, warnings);
  checkImage(input.PREMISE_PROMETHEUS_IMAGE, "PREMISE_PROMETHEUS_IMAGE", productionLike, errors, warnings);
  checkImage(input.PREMISE_OTEL_IMAGE, "PREMISE_OTEL_IMAGE", productionLike, errors, warnings);
  checkImage(input.PREMISE_NODE_BUILD_IMAGE, "PREMISE_NODE_BUILD_IMAGE", productionLike, errors, warnings);
  checkImage(input.PREMISE_NODE_RUNTIME_IMAGE, "PREMISE_NODE_RUNTIME_IMAGE", productionLike, errors, warnings);

  const poolSize = parseInteger(input.PREMISE_DB_POOL_SIZE ?? "8", "PREMISE_DB_POOL_SIZE", 1, 48, errors);
  const maxBodyBytes = parseInteger(input.PREMISE_MAX_BODY_BYTES ?? "1048576", "PREMISE_MAX_BODY_BYTES", 1_024, 67_108_864, errors);
  check("pool-budget", poolSize !== undefined, "1..48 connections");
  check("request-body-budget", maxBodyBytes !== undefined, "1 KiB..64 MiB");

  const signed = String(input.PREMISE_REQUIRE_SIGNED_ENVELOPES ?? (productionLike ? "1" : "0")).trim();
  check("signed-envelopes-production-policy", !productionLike || signed === "1", "production/staging require signed envelopes");
  if (productionLike && signed !== "1") errors.push("PREMISE_REQUIRE_SIGNED_ENVELOPES=1 (signed envelopes) is required outside development");
  if (signed === "1") {
    const keyFile = input.PREMISE_SIGNATURE_KEYS_FILE;
    check("signature-key-file-configured", realValue(keyFile) && isAbsolute(keyFile.trim()), "the verifier key file must be mounted into the container");
    if (!realValue(keyFile) || !isAbsolute(keyFile.trim())) errors.push("PREMISE_SIGNATURE_KEYS_FILE must be an absolute mounted path when signed envelopes are required");
    warnings.push("Signature verification uses the mounted public-key file; KMS/HSM rotation is an external deployment responsibility");
  }

  if (!productionLike) warnings.push("Development preflight accepts local defaults; this result is not production readiness evidence");
  if (productionLike) warnings.push("This preflight validates configuration only; it does not prove TLS, KMS/HSM, WORM backups, SLOs, or provider availability");
  return { ok: errors.length === 0, environment, errors, warnings, checks };
}

function invokedDirectly() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function readEnvFile(file) {
  const values = {};
  for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (match === null) throw new Error(`Invalid environment assignment at ${file}:${index + 1}`);
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

if (invokedDirectly()) {
  try {
    const envFileIndex = process.argv.indexOf("--env-file");
    const envFile = envFileIndex === -1 ? undefined : process.argv[envFileIndex + 1];
    if (envFileIndex !== -1 && (!configured(envFile) || envFile.startsWith("--"))) throw new Error("--env-file requires a path");
    const fileValues = envFile === undefined ? {} : readEnvFile(envFile);
    const result = validateDeploymentEnvironment({ ...fileValues, ...process.env });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
