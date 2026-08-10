import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectGaEvidence } from "../../scripts/collect-ga-evidence.mjs";

async function directories(t) {
  const root = await mkdtemp(join(tmpdir(), "premise-ga-collector-"));
  const input = join(root, "input");
  const output = join(root, "output");
  await mkdir(input, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, input, output };
}

test("collector copies real canonical artifacts and never fabricates missing evidence", async (t) => {
  const { input, output } = await directories(t);
  await writeFile(join(input, "threat-model.md"), "# Existing threat model\n", "utf8");
  await mkdir(join(input, "raw"), { recursive: true });
  await writeFile(join(input, "raw", "restore.json"), "{\"real\":true}\n", "utf8");

  const result = await collectGaEvidence({
    inputDir: input,
    outputDir: output,
    mappings: [{ target: "backup-restore.json", source: "raw/restore.json" }],
    commit: "0123456789abcdef0123456789abcdef01234567",
    source: "test://collector"
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.files.find((item) => item.evidence === "threat-model.md").status, "copied");
  assert.equal(result.files.find((item) => item.evidence === "backup-restore.json").status, "copied");
  assert.equal(await readFile(join(output, "backup-restore.json"), "utf8"), "{\"real\":true}\n");
  await assert.rejects(stat(join(output, "external-holdout.json")));
  assert.ok(result.failures.some((item) => item.code === "missing-source" && item.target === "external-holdout.json"));
  const report = JSON.parse(await readFile(join(output, "collection-report.json"), "utf8"));
  assert.equal(report.schema, "premise/ga-evidence-collection/1");
  assert.equal(report.trace.mappings[0].target, "backup-restore.json");
  assert.ok(report.contract.incompatibilities.some((item) => item.artifact === "backup-restore.json"));
});

test("collector rejects ambiguous automatic sources and requires an explicit mapping", async (t) => {
  const { input, output } = await directories(t);
  await mkdir(join(input, "one"), { recursive: true });
  await mkdir(join(input, "two"), { recursive: true });
  await writeFile(join(input, "one", "security-report.json"), "one", "utf8");
  await writeFile(join(input, "two", "security-report.json"), "two", "utf8");

  const result = await collectGaEvidence({ inputDir: input, outputDir: output });
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some((item) => item.code === "ambiguous-source" && item.target === "security-report.json"));
  await assert.rejects(stat(join(output, "security-report.json")));
});

test("collector rejects mappings outside input and records the failure", async (t) => {
  const { input, output, root } = await directories(t);
  await writeFile(join(root, "outside.json"), "not-in-input", "utf8");
  const result = await collectGaEvidence({
    inputDir: input,
    outputDir: output,
    mappings: [{ target: "external-holdout.json", source: "../outside.json" }]
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some((item) => item.code === "unsafe-source" && item.target === "external-holdout.json"));
  await assert.rejects(stat(join(output, "external-holdout.json")));
});
