import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
      await writeFile(path, "# PREMiSE threat model\n\nSecurity review: external KMS/HSM integration observed.\nTLS: enforced. OIDC identity: configured and reviewed.\nIndependent review: complete.\nOpen critical findings: 0.\nPREMiSE is not a universal security or compliance guarantee.\n", "utf8");
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
    if (requirement.name === "security-report.json") {
      Object.assign(document, {
        status: "pass",
        claims: { eligibleForGa: true },
        securityControls: {
          keyManagement: { provider: "external-kms", external: true, rotationObserved: true, revocationObserved: true, recoveryObserved: true, leastPrivilegeReviewed: true },
          transport: { tlsEnforced: true },
          identity: { oidcOrEquivalent: true, authorizationReviewed: true },
          tenantIsolation: { verified: true },
          audit: { durable: true, tamperEvidenceVerified: true, recoveryObserved: true }
        },
        independentReview: {
          status: "pass",
          separateReviewer: true,
          reviewerId: "external-reviewer-1",
          reviewReportUri: "https://evaluator.example/security-review.json",
          reviewReportSha256: "a".repeat(64),
          attestation: { verified: true, signatureScheme: "ed25519" },
          openCriticalFindings: 0,
          openHighFindings: 0
        }
      });
    }
    if (requirement.name === "external-holdout.json") Object.assign(document, {
      status: "INDEPENDENT_EVIDENCE",
      evidence: { class: "independent", independent: true, eligibleForPublicClaim: true, attestation: { verified: true, url: "https://evaluator.example/attestation.json", sha256: "b".repeat(64) } },
      eligibleForPublicClaim: true,
      benchmark: { split: "holdout", tasks: 200 },
      metrics: { correctPer100: 95, freshPer100Eligible: 99, freshnessEligible: 100 },
      verification: { externalImmutable: true, labelsLoadedAfterCandidate: true, labelsSentToCandidate: false, fixtureEvidenceUsed: false, writeRequests: 0 }
    });
    if (requirement.name === "soak-availability.json") Object.assign(document, {
      setup: { ok: true },
      acceptance: { passed: true },
      postgresTelemetry: { available: true },
      trace: { path: "soak-trace.jsonl", sha256: `sha256:${"d".repeat(64)}` },
      eligibility: { eligibleForGa: true, classification: "ga-eligible" },
      window: { activeDurationMs: 3_600_000 },
      metrics: { requests: 10_000, availabilityRate: 0.999, errorRate: 0.001, latency: { p95Ms: 500, p99Ms: 2_000 } }
    });
    if (requirement.name === "soak-availability.json") {
      const traceBody = '{"schema":"premise-ga-soak/trace/1"}\n';
      document.trace = { path: "soak-trace.jsonl", sha256: `sha256:${createHash("sha256").update(traceBody).digest("hex")}` };
      await writeFile(join(directory, "soak-trace.jsonl"), traceBody, "utf8");
    }
    if (requirement.name === "cost-report.json") Object.assign(document, {
      eligibleForGa: true,
      mode: "provider-billing",
      measurement: { real: true },
      workload: { operations: 10_000 },
      cost: { currency: "USD", thresholdPassed: true, perThousandOperationsUsd: 0.05 },
      evidence: { evidenceComplete: true, realMeasurement: true, eligibleCostEvidence: true }
    });
    if (requirement.name === "rollback-report.json") Object.assign(document, {
      status: "passed",
      ok: true,
      evidence: {
        imageReferences: { current: { id: "sha256:current" }, previous: { id: "sha256:previous" } },
        deployments: { current: {}, previous: {} },
        data: { before: { recordSha256: "c".repeat(64) }, after: { recordSha256: "c".repeat(64) } }
      },
      phases: ["deploy-current", "write-current-data", "rollback-to-previous", "verify-rollback-data"].map((name) => ({ name, status: "passed" }))
    });
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

test("claim gate rejects security, holdout, cost and rollback shortcuts", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t, async (directory) => {
    const readJson = async (name) => JSON.parse(await readFile(join(directory, name), "utf8"));
    const writeJson = async (name, value) => writeFile(join(directory, name), `${JSON.stringify(value)}\n`, "utf8");
    const security = await readJson("security-report.json");
    security.securityControls.keyManagement.provider = "in-memory-keyring";
    await writeJson("security-report.json", security);
    const holdout = await readJson("external-holdout.json");
    holdout.benchmark.tasks = 1;
    await writeJson("external-holdout.json", holdout);
    const cost = await readJson("cost-report.json");
    cost.mode = "modeled";
    await writeJson("cost-report.json", cost);
    const rollback = await readJson("rollback-report.json");
    rollback.status = "planned";
    await writeJson("rollback-report.json", rollback);
  });
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: evidenceDirectory });
  const artifact = (name) => result.evidence.artifacts.find((item) => item.name === name);

  assert.equal(result.exitCode, 1);
  for (const name of ["security-report.json", "external-holdout.json", "cost-report.json", "rollback-report.json"]) {
    assert.equal(artifact(name).eligible, false, `${name} must be ineligible`);
    assert.ok(artifact(name).failures.some((item) => item.code === "claims-contract"), `${name} must fail the claims contract`);
  }
});

test("strict soak gate recalculates the uploaded raw trace digest", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t, async (directory) => {
    await writeFile(join(directory, "soak-trace.jsonl"), "tampered\n", "utf8");
  });
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: evidenceDirectory });
  const artifact = result.evidence.artifacts.find((item) => item.name === "soak-availability.json");

  assert.equal(artifact.eligible, false);
  assert.ok(artifact.failures.some((item) => item.field === "trace.sha256"));
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

test("external holdout fails closed when its independence assertion is false", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t, async (directory) => {
    const path = join(directory, "external-holdout.json");
    const document = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8")));
    document.evidence.independent = false;
    await writeFile(path, `${JSON.stringify(document)}\n`, "utf8");
  });
  const result = await runGaGate({ rootDir: repositoryRoot, strict: true, evidenceRoot: evidenceDirectory });
  const artifact = result.evidence.artifacts.find((item) => item.name === "external-holdout.json");

  assert.equal(artifact.verified, false);
  assert.equal(artifact.independent, null);
  assert.equal(artifact.eligible, false);
  assert.ok(artifact.failures.some((item) => item.code === "claims-contract"));
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

test("non-strict mode never exposes release eligibility", async (t) => {
  const evidenceDirectory = await makeEvidenceDirectory(t);
  const result = await runGaGate({ rootDir: repositoryRoot, strict: false, evidenceRoot: evidenceDirectory });

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "implementation-checked");
  assert.equal(result.evidence.eligibleAll, true);
  assert.equal(result.eligible, false);
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
