import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateDeploymentEnvironment } from "./preflight.mjs";

function digest(name) {
  return `${name}@sha256:${"a".repeat(64)}`;
}

test("production preflight accepts complete immutable inputs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "premise-preflight-"));
  const tokenFile = path.join(directory, "metrics-token");
  await writeFile(tokenFile, `${"m".repeat(48)}\n`, { mode: 0o600 });
  const result = validateDeploymentEnvironment({
    PREMISE_ENV: "production",
    PREMISE_TENANT_ID: "tenant:prod",
    PREMISE_TABLE_PREFIX: "premise_v2",
    PREMISE_API_TOKEN: "a".repeat(48),
    PREMISE_METRICS_TOKEN: "m".repeat(48),
    PREMISE_METRICS_TOKEN_FILE: tokenFile,
    DATABASE_URL: "postgresql://premise_app:secret@db:5432/premise",
    MIGRATIONS_DATABASE_URL: "postgresql://premise_migrator:secret@db:5432/premise",
    PREMISE_IMAGE: digest("registry.example/premise-v2"),
    PREMISE_POSTGRES_IMAGE: digest("postgres"),
    PREMISE_PROMETHEUS_IMAGE: digest("prom/prometheus"),
    PREMISE_OTEL_IMAGE: digest("otel/opentelemetry-collector-contrib"),
    PREMISE_NODE_BUILD_IMAGE: digest("node"),
    PREMISE_NODE_RUNTIME_IMAGE: digest("node"),
    PREMISE_DB_POOL_SIZE: "8",
    PREMISE_MAX_BODY_BYTES: "1048576",
    PREMISE_REQUIRE_SIGNED_ENVELOPES: "1",
    PREMISE_SIGNATURE_KEYS_FILE: "/run/secrets/premise_signature_public_keys.json"
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.errors.length, 0);
});

test("production preflight rejects mutable images, placeholders, and shared roles", () => {
  const result = validateDeploymentEnvironment({
    PREMISE_ENV: "production",
    PREMISE_TENANT_ID: "tenant:prod",
    PREMISE_API_TOKEN: "short",
    PREMISE_METRICS_TOKEN: "short",
    PREMISE_METRICS_TOKEN_FILE: "__INJECT_METRICS_TOKEN_FILE__",
    DATABASE_URL: "postgresql://same:secret@db:5432/premise",
    MIGRATIONS_DATABASE_URL: "postgresql://same:secret@db:5432/premise",
    PREMISE_IMAGE: "premise-v2:latest",
    PREMISE_POSTGRES_IMAGE: "postgres:16.4-alpine",
    PREMISE_PROMETHEUS_IMAGE: "prom/prometheus:v3.5.0",
    PREMISE_OTEL_IMAGE: "otel/opentelemetry-collector-contrib:0.132.0",
    PREMISE_REQUIRE_SIGNED_ENVELOPES: "0"
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("image digest")));
  assert.ok(result.errors.some((error) => error.includes("different database roles")));
  assert.ok(result.errors.some((error) => error.includes("signed envelopes")));
});

test("production preflight rejects local-only credentials even when they look long enough", () => {
  const result = validateDeploymentEnvironment({
    PREMISE_ENV: "production",
    PREMISE_TENANT_ID: "tenant:prod",
    PREMISE_API_TOKEN: "local-only-api-token-that-is-long-enough",
    PREMISE_METRICS_TOKEN: "not-for-production-metrics-token-long-enough",
    PREMISE_METRICS_TOKEN_FILE: "C:\\secrets\\metrics-token",
    DATABASE_URL: "postgresql://premise_app:local-only-app-password@db:5432/premise",
    MIGRATIONS_DATABASE_URL: "postgresql://premise_migrator:local-only-bootstrap-password@db:5432/premise",
    PREMISE_IMAGE: digest("registry.example/premise-v2"),
    PREMISE_POSTGRES_IMAGE: digest("postgres"),
    PREMISE_PROMETHEUS_IMAGE: digest("prom/prometheus"),
    PREMISE_OTEL_IMAGE: digest("otel/opentelemetry-collector-contrib"),
    PREMISE_NODE_BUILD_IMAGE: digest("node"),
    PREMISE_NODE_RUNTIME_IMAGE: digest("node"),
    PREMISE_REQUIRE_SIGNED_ENVELOPES: "1",
    PREMISE_SIGNATURE_KEYS_FILE: "/run/secrets/premise_signature_public_keys.json"
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.filter((error) => error.includes("injected") || error.includes("placeholder")).length >= 3);
});

test("development preflight is explicit about its non-production ceiling", () => {
  const result = validateDeploymentEnvironment({ PREMISE_ENV: "development" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("not production readiness evidence")));
});
