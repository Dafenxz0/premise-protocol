import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageDir = join(root, "packages", "sdk");
const outputDir = join(root, ".tmp", "release");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await run(pnpm, ["--filter", "@premise/sdk", "build"], root);
run(npm, ["pack", "--ignore-scripts", "--pack-destination", outputDir], packageDir);
const names = (await readdir(outputDir)).filter((name) => name.endsWith(".tgz"));
assert.equal(names.length, 1, "expected one SDK tarball for the SBOM");
const tarball = join(outputDir, names[0]);
const installDir = await mkdtemp(join(tmpdir(), "premise-sbom-"));

try {
  await writeFile(join(installDir, "package.json"), JSON.stringify({
    name: "premise-sbom-consumer",
    version: "0.0.0",
    private: true
  }, null, 2) + "\n", "utf8");
  run(npm, [
    "install", "--ignore-scripts", "--no-audit", "--no-fund",
    "--package-lock-only", "--save-exact", "--loglevel=error", tarball
  ], installDir);
  const sbomText = run(npm, [
    "sbom", "--package-lock-only", "--sbom-format", "cyclonedx",
    "--sbom-type", "library", "--loglevel=error"
  ], installDir).trim();
  const sbom = JSON.parse(sbomText);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.ok(Array.isArray(sbom.components));
  await writeFile(join(outputDir, "sbom.cdx.json"), JSON.stringify(sbom, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    status: "PASS",
    format: "CycloneDX",
    package: "@premise/sdk",
    artifact: names[0],
    output: ".tmp/release/sbom.cdx.json",
    components: sbom.components.length
  }, null, 2));
} finally {
  await rm(installDir, { recursive: true, force: true });
}
