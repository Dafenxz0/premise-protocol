import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const sourceFile = argument("--file");

try {
  const bytes = await readFile(sourceFile);
  const state = JSON.parse(bytes.toString("utf8"));
  if (state === null || typeof state !== "object" || typeof state.resourceId !== "string") throw new Error("fixture state must contain resourceId");
  console.log(JSON.stringify({
    status: "PRESENT",
    resourceId: state.resourceId,
    revision: state.revision,
    value: state.value,
    version: { scheme: "sha256", token: createHash("sha256").update(bytes).digest("hex") },
    nodeVersion: process.versions.node,
    pid: process.pid
  }));
} catch (error) {
  if (error && typeof error === "object" && error.code === "ENOENT") {
    console.log(JSON.stringify({ status: "MISSING", reason: "ENOENT", nodeVersion: process.versions.node, pid: process.pid }));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
