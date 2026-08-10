import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflowPath = new URL("../../.github/workflows/ga.yml", import.meta.url);

test("GA certification is fail-closed for manual runs and required evidence cannot disappear", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /if:\s*\(github\.event_name == 'workflow_dispatch' \|\| startsWith\(github\.ref, 'refs\/tags\/v2\.'\)\) && always\(\)/u);
  assert.match(workflow, /needs:\s*\[security, deterministic-load, million-load, external-github, external-holdout, integration, production-soak, cost-evidence, rollback-certification\]/u);
  assert.doesNotMatch(workflow, /premise:\/tmp\/soak-availability\.json\s*\\\s*\.ga-artifacts\/soak-availability\.json\s*\|\| true/u);

  const certification = workflow.slice(workflow.indexOf("  ga-certification:"));
  assert.match(certification, /test "\$result" = success/u);
  for (const campaign of ["SECURITY", "DETERMINISTIC_LOAD", "MILLION_LOAD", "EXTERNAL_GITHUB", "EXTERNAL_HOLDOUT", "INTEGRATION", "PRODUCTION_SOAK", "COST_EVIDENCE", "ROLLBACK"]) {
    assert.match(certification, new RegExp(`^          ${campaign}:`, "mu"));
  }
});

console.log("GA workflow fail-closed tests passed");
