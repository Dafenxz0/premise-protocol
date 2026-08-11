import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflowPath = new URL("../../.github/workflows/ga.yml", import.meta.url);

test("GA certification is fail-closed for manual runs and required evidence cannot disappear", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /if:\s*always\(\) && \(github\.event_name == 'workflow_dispatch' \|\| startsWith\(github\.ref, 'refs\/tags\/v2\.'\)\)/u);
  assert.match(workflow, /needs:\s*\[security, deterministic-load, million-load, postgres-scale, external-github, external-holdout, integration, production-soak, cost-evidence, rollback-certification\]/u);
  assert.doesNotMatch(workflow, /premise:\/tmp\/soak-availability\.json\s*\\\s*\.ga-artifacts\/soak-availability\.json\s*\|\| true/u);
  assert.match(workflow, /--output benchmarks\/ga-load\/load-full\.json/u);
  assert.doesNotMatch(workflow, /results-full\.json/u);
  assert.match(workflow, /\.ga-artifacts\/recovery-report\.json/u);
  assert.doesNotMatch(workflow, /\.ga-artifacts\/postgres-scale-restart\.json/u);
  assert.match(workflow, /scripts\/generate-ga-signing-key\.mjs/u);
  assert.match(workflow, /PREMISE_REQUIRE_SIGNED_ENVELOPES=1/u);
  assert.match(workflow, /PREMISE_SIGNATURE_PRIVATE_KEY_FILE=\/run\/secrets\/premise_signature_private_key\.pem/u);
  assert.match(workflow, /-v "\$PWD\/\.local\/premise_signature_private_key\.pem:\/run\/secrets\/premise_signature_private_key\.pem:ro"/u);

  const postgresScale = workflow.slice(workflow.indexOf("  postgres-scale:"), workflow.indexOf("  external-github:"));
  const roleProvision = postgresScale.indexOf('run: docker compose -f "${COMPOSE_FILE}" run --rm --no-deps db-roles');
  const migration = postgresScale.indexOf('run: docker compose -f "${COMPOSE_FILE}" run --rm --no-deps migrate');
  assert.ok(roleProvision >= 0, "postgres-scale must provision db-roles explicitly");
  assert.ok(migration > roleProvision, "postgres-scale must provision db-roles before migrate");

  const postgresApiStart = postgresScale.slice(
    postgresScale.indexOf("      - name: Start production-shaped API after real seed"),
    postgresScale.indexOf("      - name: Wait for API readiness after scale seed")
  );
  assert.match(postgresScale, /printf '%s\\n' "\$metrics_token" > \.local\/premise_metrics_token/u);
  assert.match(postgresApiStart, /metrics_token="\$\(cat \.local\/premise_metrics_token\)"/u);
  assert.match(postgresApiStart, /echo "PREMISE_METRICS_TOKEN=\$metrics_token" >> "\$GITHUB_ENV"/u);
  assert.match(postgresApiStart, /export PREMISE_METRICS_TOKEN="\$metrics_token"/u);

  const metricsSmoke = workflow.slice(
    workflow.indexOf("      - name: Verify Prometheus metrics endpoint"),
    workflow.indexOf("      - name: Create and verify a backup")
  );
  assert.match(metricsSmoke, /authorization: `Bearer \$\{process\.env\.PREMISE_METRICS_TOKEN\}`/u);

  const productionSoak = workflow.slice(workflow.indexOf("  production-soak:"), workflow.indexOf("  cost-evidence:"));
  const soakStart = productionSoak.slice(
    productionSoak.indexOf("      - name: Start production-shaped stack"),
    productionSoak.indexOf("      - name: Wait for readiness")
  );
  assert.match(productionSoak, /printf '%s\\n' "\$metrics_token" > \.local\/premise_metrics_token/u);
  assert.match(soakStart, /export PREMISE_METRICS_TOKEN="\$\(cat \.local\/premise_metrics_token\)"/u);
  assert.match(soakStart, /up -d --no-build premise prometheus otel-collector/u);
  assert.match(productionSoak, /run --rm --no-deps[\s\S]*?--base-url http:\/\/premise:3000/u);

  const postgresRawVerification = workflow.slice(
    workflow.indexOf("      - name: Verify PostgreSQL scale raw evidence"),
    workflow.indexOf("      - name: Upload real PostgreSQL scale evidence")
  );
  assert.match(postgresRawVerification, /test -s "\$file"/u);
  for (const rawFile of [
    "postgres-scale-traces.jsonl",
    "recovery-report-traces.jsonl",
    "soak-run.log",
    "soak-availability.json"
  ]) {
    assert.match(postgresRawVerification + workflow, new RegExp(rawFile.replace(".", "\\."), "u"));
  }

  const certification = workflow.slice(workflow.indexOf("  ga-certification:"));
  assert.match(certification, /actions\/download-artifact@v4/u);
  assert.match(certification, /scripts\/collect-ga-evidence\.mjs/u);
  assert.match(certification, /--strict-maps/u);
  for (const mapping of [
    "external-holdout.json=premise-ga-holdout-${GITHUB_SHA}/external-holdout.json",
    "dataset-manifest.json=premise-ga-holdout-${GITHUB_SHA}/dataset-manifest.json",
    "load-full.json=premise-ga-load-full-${GITHUB_SHA}/load-full.json",
    "postgres-scale.json=premise-ga-postgres-scale-${GITHUB_SHA}/postgres-scale.json",
    "recovery-report.json=premise-ga-postgres-scale-${GITHUB_SHA}/recovery-report.json",
    "soak-availability.json=premise-ga-soak-${GITHUB_SHA}/soak-availability.json",
    "cost-report.json=premise-ga-cost-${GITHUB_SHA}/cost-report.json",
    "rollback-report.json=premise-ga-rollback-${GITHUB_SHA}/rollback-report.json",
    "backup-restore.json=premise-ga-evidence-${GITHUB_SHA}/.ga-artifacts/restore-verify.json"
  ]) assert.match(certification, new RegExp(`--map "${mapping.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"));
  assert.match(certification, /scripts\/ga-gate\.mjs --strict/u);
  assert.match(certification, /PREMISE_GA_EVIDENCE_DIR=\.ga-artifacts\/canonical node scripts\/ga-gate\.mjs --strict/u);
  assert.doesNotMatch(certification, /PREMiSE_GA_EVIDENCE_DIR/u, "the evidence directory environment variable must match on Linux");
  assert.match(certification, /campaign-status\.exit/u);
  assert.match(certification, /collector\.exit/u);
  assert.match(certification, /ga-gate\.exit/u);
  assert.match(certification, /name: Upload final GA certification bundle[\s\S]*?actions\/upload-artifact@v4/u);
  assert.match(certification, /premise-ga-certification-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}/u);
  for (const campaign of ["SECURITY", "DETERMINISTIC_LOAD", "MILLION_LOAD", "POSTGRES_SCALE", "EXTERNAL_GITHUB", "EXTERNAL_HOLDOUT", "INTEGRATION", "PRODUCTION_SOAK", "COST_EVIDENCE", "ROLLBACK"]) {
    assert.match(certification, new RegExp("^          " + campaign + ":", "mu"));
  }
});

console.log("GA workflow fail-closed tests passed");
