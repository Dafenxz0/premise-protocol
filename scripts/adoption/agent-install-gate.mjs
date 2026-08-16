import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourcePlugin = join(root, "plugins", "premise-codex");
const artifactRoot = join(root, ".tmp", "adoption", "agent-install-gate");
const copiedPlugin = join(artifactRoot, "copied-plugin");
const fixture = join(artifactRoot, "fixture");
const installer = join(copiedPlugin, "install.mjs");

async function run(args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [installer, ...args], {
      cwd: copiedPlugin,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

await rm(artifactRoot, { recursive: true, force: true });
await mkdir(fixture, { recursive: true });
await cp(sourcePlugin, copiedPlugin, { recursive: true });
await writeFile(join(fixture, ".mcp.json"), `${JSON.stringify({
  mcpServers: { existing: { command: "node", args: ["existing.mjs"] } }
}, null, 2)}\n`);
await writeFile(join(fixture, "CLAUDE.md"), "# Existing Claude instructions\n", "utf8");
await writeFile(join(fixture, "AGENTS.md"), "# Existing agent instructions\n", "utf8");

const first = await run(["--agent", "all", "--project", fixture]);
assert.equal(first.code, 0, first.stderr);
const firstReport = JSON.parse(first.stdout);
assert.equal(firstReport.status, "PASS");

const second = await run(["--agent", "all", "--project", fixture]);
assert.equal(second.code, 0, second.stderr);
const check = await run(["--check", "--agent", "all", "--project", fixture]);
assert.equal(check.code, 0, check.stderr);

const claude = await readFile(join(fixture, "CLAUDE.md"), "utf8");
const agents = await readFile(join(fixture, "AGENTS.md"), "utf8");
assert.equal(claude.includes("# Existing Claude instructions"), true);
assert.equal(agents.includes("# Existing agent instructions"), true);
assert.equal((claude.match(/premise-managed:begin/gu) ?? []).length, 1);
assert.equal((claude.match(/premise-managed:end/gu) ?? []).length, 1);
assert.equal((agents.match(/premise-managed:begin/gu) ?? []).length, 1);
assert.equal((agents.match(/premise-managed:end/gu) ?? []).length, 1);

const mcpConfig = await readJson(join(fixture, ".mcp.json"));
assert.deepEqual(mcpConfig.mcpServers.existing, { command: "node", args: ["existing.mjs"] });
assert.deepEqual(mcpConfig.mcpServers.premise, {
  command: "node",
  args: [".premise/premise-codex/mcp/server.mjs"]
});
const genericConfig = await readJson(join(fixture, ".premise", "premise.mcp.json"));
assert.deepEqual(genericConfig.mcpServers.premise, mcpConfig.mcpServers.premise);
const generated = await readFile(join(fixture, ".premise", "premise-codex", "mcp", "server.mjs"), "utf8");
assert.equal(generated.includes("PREMISE_TOKEN"), true);
assert.equal((await readFile(join(fixture, ".mcp.json"), "utf8")).includes("sentinel-secret"), false);

const server = spawn(process.execPath, [".premise/premise-codex/mcp/server.mjs"], {
  cwd: fixture,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  stdio: ["pipe", "pipe", "pipe"]
});
let stdout = "";
server.stdout.on("data", (chunk) => { stdout += chunk; });
const response = new Promise((resolvePromise, reject) => {
  const timeout = setTimeout(() => reject(new Error("installed MCP did not answer")), 5_000);
  const onData = () => {
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    if (lines.length === 0) return;
    clearTimeout(timeout);
    server.stdout.off("data", onData);
    resolvePromise(JSON.parse(lines[0]));
  };
  server.stdout.on("data", onData);
});
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
const initialized = await response;
assert.equal(initialized.result.serverInfo.name, "premise");
server.kill();

const report = {
  format: "premise-agent-install-gate-report/1",
  status: "PASS",
  copiedPlugin: true,
  agents: ["codex", "claude-code", "generic"],
  idempotent: true,
  existingMcpPreserved: true,
  credentialsNotEmbedded: true,
  copiedMcpSelftest: true
};
await writeFile(join(artifactRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
