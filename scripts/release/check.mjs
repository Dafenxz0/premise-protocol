import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const expectedVersion = "2.0.0-rc.2";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

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

const rootManifest = await readJson(join(root, "package.json"));
const sdkManifest = await readJson(join(root, "packages", "sdk", "package.json"));
const readme = await readFile(join(root, "README.md"), "utf8");

assert.equal(rootManifest.version, expectedVersion);
assert.equal(sdkManifest.version, expectedVersion);
assert.equal(rootManifest.license, "Apache-2.0");
assert.equal(sdkManifest.license, "Apache-2.0");
assert.equal(rootManifest.bin?.["premise-install"], "plugins/premise-codex/install.mjs");
assert.ok(rootManifest.files?.includes("plugins/premise-codex"));
assert.ok(rootManifest.files?.includes("LICENSE"));
assert.match(readme, /PREMiSE 2 is the current candidate protocol/u);
assert.match(readme, /`premise\/2`/u);
assert.match(readme, /`premise\/1` and `premise\/1\.1` are frozen/u);
assert.match(readme, /PREMiSE NEXT/u);
assert.match(readme, /premise-install/u);
assert.match(readme, /github:Dafenxz0\/premise-protocol#v2\.0\.0-rc\.2/u);
assert.doesNotMatch(readme, /github:Dafenxz0\/premise-protocol#main/u);
await access(join(root, "LICENSE"));

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const temporaryRoot = await mkdtemp(join(tmpdir(), "premise-release-check-"));
const packDir = join(temporaryRoot, "pack");
const fixture = join(temporaryRoot, "consumer");

try {
  await mkdir(packDir);
  await mkdir(fixture);
  run(npm, ["pack", "--ignore-scripts", "--pack-destination", packDir], root);
  const tarballs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "expected one installable repository tarball");
  const tarball = join(packDir, tarballs[0]);

  const installed = JSON.parse(run(npx, [
    "--yes", "--package", tarball, "premise-install",
    "--agent", "all", "--project", fixture
  ], fixture));
  assert.equal(installed.status, "PASS");

  const checked = JSON.parse(run(npx, [
    "--yes", "--package", tarball, "premise-install",
    "--check", "--agent", "all", "--project", fixture
  ], fixture));
  assert.equal(checked.status, "PASS");
  await access(join(fixture, ".agents", "skills", "premise", "SKILL.md"));
  await access(join(fixture, ".premise", "premise-codex", "mcp", "server.mjs"));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  status: "PASS",
  version: expectedVersion,
  protocol: "premise/2",
  license: "Apache-2.0",
  installer: "premise-install",
  installerEntrypoint: "PASS",
  sbom: "release:sbom"
}, null, 2));
