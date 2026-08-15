#!/usr/bin/env node

/**
 * Install the portable PREMiSE agent kit into a project.
 *
 * This script intentionally uses only Node.js built-ins. It can run from the
 * repository or from a copied standalone plugin directory.
 */

import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const sourceSkill = join(pluginRoot, "skills", "premise");
const sourceMcp = join(pluginRoot, "mcp");
const startMarker = "<!-- premise-managed:begin -->";
const endMarker = "<!-- premise-managed:end -->";

function parseArgs(argv) {
  const options = { agent: "all", project: process.cwd(), force: false, check: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--force") options.force = true;
    else if (value === "--check") options.check = true;
    else if (value.startsWith("--agent=")) options.agent = value.slice("--agent=".length);
    else if (value === "--agent") options.agent = argv[++index];
    else if (value.startsWith("--project=")) options.project = value.slice("--project=".length);
    else if (value === "--project") options.project = argv[++index];
    else throw new Error(`unknown option: ${value}`);
  }
  return options;
}

function usage() {
  console.log(`PREMiSE portable agent kit

Usage:
  node plugins/premise-codex/install.mjs --agent all --project .

Agents:
  codex       Install .agents/skills/premise and the project MCP entry.
  claude-code Install a managed CLAUDE.md import and the project MCP entry.
  generic     Install AGENTS.md guidance and a standalone MCP config.
  all         Install all three integrations (default).

Options:
  --project PATH  Project to install into (default: current directory).
  --force         Replace conflicting PREMiSE-managed files/config entries.
  --check         Verify an existing installation without changing files.
`);
}

function assertAgent(agent) {
  if (!["codex", "claude-code", "generic", "all"].includes(agent)) {
    throw new Error("--agent must be codex, claude-code, generic, or all");
  }
}

function enabled(agent, target) {
  return agent === "all" || agent === target;
}

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function copyTree(source, destination, force) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, force);
    else await copyFile(from, to, force);
  }
}

async function copyFile(source, destination, force) {
  const content = await readFile(source);
  const current = await readIfPresent(destination);
  if (current !== null) {
    if (Buffer.from(current).equals(content)) return false;
    if (!force) throw new Error(`destination already exists and differs: ${destination}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  return true;
}

async function appendManagedBlock(file, block, force) {
  const current = await readIfPresent(file);
  if (current?.includes(startMarker) && current.includes(endMarker)) {
    const start = current.indexOf(startMarker);
    const end = current.indexOf(endMarker, start) + endMarker.length;
    const existingBlock = current.slice(start, end);
    if (existingBlock === block) return false;
    if (!force) throw new Error(`PREMiSE-managed block differs in ${file}; rerun with --force`);
    await writeFile(file, `${current.slice(0, start)}${block}${current.slice(end)}`, "utf8");
    return true;
  }
  if (current !== null && !force && current.trim().length > 0) {
    await writeFile(file, `${current.trimEnd()}\n\n${block}\n`, "utf8");
    return true;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, current && force ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`, "utf8");
  return true;
}

async function mergeMcpConfig(file, server, force) {
  const currentText = await readIfPresent(file);
  let config = {};
  if (currentText !== null) {
    try {
      config = JSON.parse(currentText);
    } catch {
      throw new Error(`MCP config is not valid JSON: ${file}`);
    }
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`MCP config root must be an object: ${file}`);
  }
  const existing = config.mcpServers?.premise;
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(server) && !force) {
    throw new Error(`MCP server "premise" already differs in ${file}; rerun with --force`);
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), premise: server };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return existing === undefined || JSON.stringify(existing) !== JSON.stringify(server);
}

function managedImport(relativePath) {
  return `${startMarker}\n@${relativePath}\n${endMarker}`;
}

function managedAgentNote(relativePath) {
  return `${startMarker}\nWhen a task depends on mutable external state, read ${relativePath} and follow its observe → revalidate → guarded-action workflow.\n${endMarker}`;
}

function mcpServer() {
  return {
    command: "node",
    args: [".premise/premise-codex/mcp/server.mjs"]
  };
}

async function install(options) {
  const project = resolve(options.project);
  assertAgent(options.agent);
  const files = [];

  await copyTree(sourceMcp, join(project, ".premise", "premise-codex", "mcp"), options.force);
  await copyTree(sourceSkill, join(project, ".premise", "premise-codex", "skills", "premise"), options.force);
  files.push(".premise/premise-codex/mcp/server.mjs", ".premise/premise-codex/skills/premise/SKILL.md");

  if (enabled(options.agent, "codex")) {
    await copyTree(sourceSkill, join(project, ".agents", "skills", "premise"), options.force);
    files.push(".agents/skills/premise/SKILL.md");
  }

  if (enabled(options.agent, "claude-code")) {
    const changed = await appendManagedBlock(
      join(project, "CLAUDE.md"),
      managedImport(".premise/premise-codex/skills/premise/SKILL.md"),
      options.force
    );
    if (changed) files.push("CLAUDE.md");
  }

  if (enabled(options.agent, "generic")) {
    const changed = await appendManagedBlock(
      join(project, "AGENTS.md"),
      managedAgentNote(".premise/premise-codex/skills/premise/SKILL.md"),
      options.force
    );
    if (changed) files.push("AGENTS.md");
    await mergeMcpConfig(join(project, ".premise", "premise.mcp.json"), mcpServer(), options.force);
    files.push(".premise/premise.mcp.json");
  }

  if (enabled(options.agent, "codex") || enabled(options.agent, "claude-code")) {
    await mergeMcpConfig(join(project, ".mcp.json"), mcpServer(), options.force);
    files.push(".mcp.json");
  }

  return {
    format: "premise-agent-install-report/1",
    status: "PASS",
    agent: options.agent,
    project,
    mode: "SELFTEST (set PREMISE_MODE=REMOTE for a deployment)",
    files: [...new Set(files)],
    next: {
      codex: enabled(options.agent, "codex") ? "Start Codex in this project; the premise skill is available as $premise." : undefined,
      claudeCode: enabled(options.agent, "claude-code") ? "Start Claude Code, approve the project MCP server, then use /mcp to inspect it." : undefined,
      generic: enabled(options.agent, "generic") ? "Load .premise/premise.mcp.json in the host's MCP configuration." : undefined,
      remote: "Set PREMISE_MODE=REMOTE, PREMISE_BASE_URL, PREMISE_TENANT and PREMISE_TOKEN only in the process environment."
    }
  };
}

async function check(options) {
  const project = resolve(options.project);
  assertAgent(options.agent);
  const expected = [
    join(project, ".premise", "premise-codex", "mcp", "server.mjs"),
    join(project, ".premise", "premise-codex", "skills", "premise", "SKILL.md")
  ];
  if (enabled(options.agent, "codex")) expected.push(join(project, ".agents", "skills", "premise", "SKILL.md"));
  if (enabled(options.agent, "claude-code")) expected.push(join(project, "CLAUDE.md"));
  if (enabled(options.agent, "generic")) expected.push(join(project, "AGENTS.md"), join(project, ".premise", "premise.mcp.json"));
  if (enabled(options.agent, "codex") || enabled(options.agent, "claude-code")) expected.push(join(project, ".mcp.json"));
  const missing = [];
  for (const file of expected) if ((await readIfPresent(file)) === null) missing.push(file);
  if (missing.length > 0) throw new Error(`PREMiSE installation is incomplete:\n${missing.join("\n")}`);
  return { format: "premise-agent-install-report/1", status: "PASS", agent: options.agent, project, checked: expected.map((file) => file.slice(project.length + 1).split(sep).join("/")) };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage();
  else console.log(JSON.stringify(options.check ? await check(options) : await install(options), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
