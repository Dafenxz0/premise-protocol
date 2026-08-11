import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseCandidateMessage, startMessage } from "./protocol.mjs";

function parseCommand(command) {
  if (Array.isArray(command)) return command;
  if (typeof command !== "string" || command.trim() === "") throw new Error("candidate command is required");
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
    const quote = part[0];
    return (quote === '"' || quote === "'") && part.at(-1) === quote ? part.slice(1, -1) : part;
  }) ?? [];
  if (parts.length === 0) throw new Error("candidate command is empty");
  return parts;
}

export async function runExternalCandidate({ command, task, initial, world, maxTurns = 20, timeoutMs = 30_000 }) {
  const [executable, ...args] = parseCommand(command);
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const messages = [];
  let turns = 0;
  let finished = false;
  const close = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send(startMessage({ taskId: task.taskId, source: task.source, memory: initial }));
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      turns += 1;
      if (turns > maxTurns) throw new Error("candidate exceeded maxTurns");
      const message = parseCandidateMessage(JSON.parse(line));
      messages.push(message);
      if (message.type === "done") {
        finished = true;
        break;
      }
      if (message.type === "read") send({ protocol: "premisebench-agent/1", type: "tool-result", tool: "read", result: await world.read() });
      else if (message.type === "act") send({ protocol: "premisebench-agent/1", type: "tool-result", tool: "act", result: await world.act(message.action) });
      else if (message.type === "actIfVersion") send({ protocol: "premisebench-agent/1", type: "tool-result", tool: "actIfVersion", result: await world.actIfVersion(message.expectedVersion, message.action) });
      else if (message.type === "reject") send({ protocol: "premisebench-agent/1", type: "tool-result", tool: "reject", result: await world.reject(message.action) });
    }
    child.stdin.end();
    const code = await close;
    if (!finished) throw new Error(`candidate ended before done (code ${code})${errors.length ? `: ${errors.join("")}` : ""}`);
    return { messages, turns, exitCode: code };
  } finally {
    clearTimeout(timer);
    lines.close();
    if (!child.killed) child.kill();
  }
}

if (process.argv[1]?.endsWith("harness/runner.mjs")) {
  console.error("runner.mjs is a library; use it from a campaign runner with a controlled world");
}
