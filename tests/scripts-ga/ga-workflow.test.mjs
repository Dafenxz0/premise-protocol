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

  const postgresScale = workflow.slice(workflow.indexOf("  postgres-scale:"), workflow.indexOf("  external-github:"));
  const roleProvision = postgresScale.indexOf('run: docker compose -f "${COMPOSE_FILE}" run --rm --no-deps db-roles');
  const migration = postgresScale.indexOf('run: docker compose -f "${COMPOSE_FILE}" run --rm --no-deps migrate');
  assert.ok(roleProvision >= 0, "postgres-scale must provision db-roles explicitly");
  assert.ok(migration > roleProvision, "postgres-scale must provision db-roles before migrate");

  const postgresApiStart = postgresScale.slice(
    postgresScale.indexOf("      - name: Start production-shaped API after real seed"),
    postgresScale.indexOf("      - name: Wait for API readiness after scale seed")
  );
  assert.match(postgresApiStart, /metrics_token="\$\(openssl rand -hex 32\)"/u);
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
  assert.match(soakStart, /export PREMISE_METRICS_TOKEN="\$\(openssl rand -hex 32\)"/u);
  assert.match(soakStart, /up -d --no-build premise prometheus otel-collector/u);

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
  assert.match(certification, /test "\$result" = success/u);
  for (const campaign of ["SECURITY", "DETERMINISTIC_LOAD", "MILLION_LOAD", "POSTGRES_SCALE", "EXTERNAL_GITHUB", "EXTERNAL_HOLDOUT", "INTEGRATION", "PRODUCTION_SOAK", "COST_EVIDENCE", "ROLLBACK"]) {
    assert.match(certification, new RegExp("^          " + campaign + ":", "mu"));
  }
});

console.log("GA workflow fail-closed tests passed");
