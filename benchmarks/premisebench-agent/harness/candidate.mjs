import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
let snapshot;
for await (const line of input) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.type === "start") {
    snapshot = message.memory;
    process.stdout.write(`${JSON.stringify({ protocol: "premisebench-agent/1", type: "read" })}\n`);
  } else if (message.type === "tool-result" && message.tool === "read") {
    snapshot = message.result;
    const action = snapshot.content?.status === "blocked"
      ? { kind: "reject", basedOnVersion: snapshot.version, reason: "source-blocked" }
      : { kind: "apply", basedOnVersion: snapshot.version, value: snapshot.content?.value };
    process.stdout.write(`${JSON.stringify({ protocol: "premisebench-agent/1", type: "actIfVersion", expectedVersion: snapshot.version, action })}\n`);
  } else if (message.type === "tool-result" && (message.tool === "actIfVersion" || message.tool === "reject")) {
    process.stdout.write(`${JSON.stringify({ protocol: "premisebench-agent/1", type: "done" })}\n`);
    break;
  }
}
