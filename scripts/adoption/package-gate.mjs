import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactRoot = join(root, ".tmp", "adoption", "package-gate");
const packageDir = join(root, "packages", "sdk");
const consumerRoot = join(root, "adoption", "external-consumers");
const isWindows = process.platform === "win32";
const npmCommand = "npm";
const pnpmCommand = "pnpm";

function quoteForCmd(value) {
  return "\"" + value.replaceAll("\"", "\\\"") + "\"";
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = isWindows
      ? spawn([command, ...args.map(quoteForCmd)].join(" "), {
          cwd,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        })
      : spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { command: [command, ...args].join(" "), code, stdout, stderr };
      if (code === 0) resolvePromise(result);
      else {
        const error = new Error(result.command + " failed with exit code " + code + "\n" + stderr + stdout);
        error.result = result;
        reject(error);
      }
    });
  });
}

await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true });

await run(pnpmCommand, ["--filter", "@premise/sdk", "build"], root);
await run(npmCommand, ["pack", "--ignore-scripts", "--pack-destination", artifactRoot], packageDir);

const artifacts = (await readdir(artifactRoot)).filter((name) => name.endsWith(".tgz"));
assert.equal(artifacts.length, 1, "expected exactly one SDK tarball");
const tarball = join(artifactRoot, artifacts[0]);
const fixtures = (await readdir(consumerRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(fixtures, ["filesystem-agent", "github-agent", "rest-agent"]);

const results = [];
for (const fixture of fixtures) {
  const source = join(consumerRoot, fixture);
  const target = join(artifactRoot, "consumers", fixture);
  await cp(source, target, { recursive: true });
  const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  assert.equal(manifest.private, true);
  assert.equal("workspaces" in manifest, false);
  await run(npmCommand, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    tarball
  ], target);
  await run(npmCommand, ["run", "smoke", "--silent"], target);
  results.push({ fixture, status: "PASS", installMode: "local-tarball", workspace: false });
}

const report = {
  status: "PASS",
  package: "@premise/sdk",
  artifact: artifacts[0],
  registryPublication: "NOT_RUN",
  consumers: results
};
await writeFile(join(artifactRoot, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
