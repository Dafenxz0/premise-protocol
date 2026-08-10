import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadAcceptanceManifest,
  listEvidenceRequirements,
  runGaGate,
  repositoryRoot
} from "../../scripts/ga-gate.mjs";

const generatedAt = "2026-08-10T12:00:00.000Z";

test("public README and acceptance manifest use the same evidence names", async () => {
  const manifest = await loadAcceptanceManifest();
  const readme = await readFile(new URL("../../spec/ga/README.md", import.meta.url), "utf8");
  for (const requirement of listEvidenceRequirements(manifest)) assert.ok(readme.includes(`\`${requirement.name}\``), `README is missing canonical evidence name ${requirement.name}`);
});

async function makeEvidenceDirectory(t, mutate = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "premise-ga-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = await loadAcceptanceManifest();
  for (const requirement of listEvidenceRequirements(manifest)) {
    const path = join(directory, requirement.name);
    if (requirement.name === "threat-model.md") {
      await writeFile(path, "# PREMiSE threat model\n\nEvidence-backed security review.\n", "utf8");
      continue;
    }
    const document = {
      schema: "premise/ga-evidence/1",
      commit: "0123456789abcdef0123456789abcdef01234567",
      generatedAt,
      source: { kind: "test-runner", uri: "test://ga-evidence" },
      trace: ["trace.jsonl"],
      metrics: { observed: true }
    };
    if (requirement.name === "external-holdout.json") document.independent = true;
    await writeFile(path, `${JSON.stringify(document)}\n`, "utf8");
  }
  await mutate(directory, manifest);
  return directory;
}

test("strict gate verifies presence, contract metadata, independence and eligibility separately", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t);
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: evidenceDirectory });
  const requiredEvidence = listEvidenceRequirements(await loadAcceptanceManifest());

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "evidence-checked");
  assert.equal(result.presence, true);
  assert.equal(result.verified, true);
  assert.equal(result.independent, true);
  assert.equal(result.eligible, true);
  assert.equal(result.evidence.present, requiredEvidence.length);
  assert.equal(result.evidence.verified, requiredEvidence.length);
  assert.equal(result.evidence.independent, 1);
  assert.equal(result.evidence.independentRequired, 1);
  assert.equal(result.evidence.eligible, requiredEvidence.length);
  assert.deepEqual(result.failures, []);
});

test("strict gate fails closed for empty, malformed and missing evidence and reports each failure", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t, async (directory) => {
    await writeFile(join(directory, "threat-model.md"), " \n", "utf8");
    await writeFile(join(directory, "conformance-v2.json"), "{not-json", "utf8");
    await rm(join(directory, "sdk-contract.json"));
  });
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: evidenceDirectory });
  const artifact = (name) => result.evidence.artifacts.find((item) => item.name === name);

  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "evidence-failed");
  assert.equal(artifact("threat-model.md").presence.exists, true);
  assert.equal(artifact("threat-model.md").presence.nonEmpty, false);
  assert.equal(artifact("threat-model.md").verified, false);
  assert.equal(artifact("conformance-v2.json").presence.nonEmpty, true);
  assert.equal(artifact("conformance-v2.json").verified, false);
  assert.equal(artifact("sdk-contract.json").presence.exists, false);
  assert.ok(result.failures.some((item) => item.code === "empty" && item.artifact === "threat-model.md"));
  assert.ok(result.failures.some((item) => item.code === "invalid-json" && item.artifact === "conformance-v2.json"));
  assert.ok(result.failures.some((item) => item.code === "missing" && item.artifact === "sdk-contract.json"));
});

test("legacy-shaped JSON is reported as incompatible instead of being silently enriched", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t, async (directory) => {
    await writeFile(join(directory, "security-report.json"), JSON.stringify({ format: "security-report/1", result: "pass" }), "utf8");
  });
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: evidenceDirectory });
  const artifact = result.evidence.artifacts.find((item) => item.name === "security-report.json");

  assert.equal(result.exitCode, 1);
  assert.equal(artifact.presence.nonEmpty, true);
  assert.equal(artifact.verified, false);
  assert.equal(artifact.eligible, false);
  assert.ok(artifact.failures.some((item) => item.code === "metadata-missing" && item.field === "schema"));
  assert.ok(artifact.incompatibilities.some((item) => item.code === "ga-evidence-metadata-contract"));
  assert.ok(result.incompatibilities.some((item) => item.artifact === "security-report.json"));
});

test("canonical GA artifacts accept the PostgreSQL commit metadata object when schema and format agree", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t, async (directory) => {
    const path = join(directory, "postgres-scale.json");
    const document = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8")));
    document.commit = { value: document.commit, source: "github.sha" };
    document.format = document.schema;
    await writeFile(path, `${JSON.stringify(document)}\n`, "utf8");
  });
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: evidenceDirectory });
  const artifact = result.evidence.artifacts.find((item) => item.name === "postgres-scale.json");

  assert.equal(artifact.verified, true);
  assert.equal(result.exitCode, 0);
});

test("commit metadata remains fail-closed for short or malformed SHA values", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t, async (directory) => {
    const path = join(directory, "postgres-scale.json");
    const document = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8")));
    document.commit = { value: "not-a-full-commit", source: "github.sha" };
    await writeFile(path, `${JSON.stringify(document)}\n`, "utf8");
  });
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: evidenceDirectory });
  const artifact = result.evidence.artifacts.find((item) => item.name === "postgres-scale.json");

  assert.equal(result.exitCode, 1);
  assert.ok(artifact.failures.some((item) => item.code === "metadata-invalid" && item.field === "commit"));
});

test("GA evidence rejects a schema and format naming mismatch", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t, async (directory) => {
    const path = join(directory, "postgres-scale.json");
    const document = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8")));
    document.format = "legacy/postgres-scale/1";
    await writeFile(path, `${JSON.stringify(document)}\n`, "utf8");
  });
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: evidenceDirectory });
  const artifact = result.evidence.artifacts.find((item) => item.name === "postgres-scale.json");

  assert.equal(result.exitCode, 1);
  assert.ok(artifact.failures.some((item) => item.code === "schema-mismatch"));
});

test("external holdout can be contract-valid but ineligible without independent reproduction", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t, async (directory) => {
    const path = join(directory, "external-holdout.json");
    const document = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8")));
    document.independent = false;
    await writeFile(path, `${JSON.stringify(document)}\n`, "utf8");
  });
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: evidenceDirectory });
  const artifact = result.evidence.artifacts.find((item) => item.name === "external-holdout.json");

  assert.equal(artifact.verified, true);
  assert.equal(artifact.independent, false);
  assert.equal(artifact.eligible, false);
  assert.ok(artifact.failures.some((item) => item.code === "independence-required"));
  assert.equal(result.eligible, false);
  assert.equal(result.exitCode, 1);
});

test("strict mode requires an evidence directory", async () => {
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "evidence-failed");
  assert.ok(result.failures.some((item) => item.code === "evidence-root-required"));
});

test("non-strict evidence inspection reports incompleteness without pretending it is GA", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t, async (directory) => {
    await rm(join(directory, "external-holdout.json"));
  });
  const result = await runGaGate({ rootDir: repositoryRoot, strict: false, evidenceRoot: evidenceDirectory });

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "evidence-incomplete");
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some((item) => item.code === "missing" && item.artifact === "external-holdout.json"));
});

test("strict mode fails when the evidence path is not readable as a directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "premise-ga-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: join(directory, "does-not-exist") });

  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "evidence-failed");
  assert.ok(result.failures.some((item) => item.code === "evidence-root"));
});

test("invalid manifest shape produces a structured fail-closed result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "premise-ga-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "acceptance.json");
  await writeFile(manifestPath, "null\n", "utf8");
  const result = await runGaGate({ rootDir: repositoryRoot, manifestPath, strict: true, evidenceRoot: directory });

  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "implementation-failed");
  assert.ok(result.failures.some((item) => item.code === "manifest-shape"));
  assert.ok(result.failures.some((item) => item.code === "evidence-skipped"));
});
