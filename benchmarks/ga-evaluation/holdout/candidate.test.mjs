import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const candidatePath = fileURLToPath(new URL("./candidate.mjs", import.meta.url));
const child = spawn(process.execPath, [candidatePath], { stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();

function next() {
  return iterator.next().then((result) => {
    if (result.done) throw new Error("candidate exited before responding");
    return JSON.parse(result.value);
  });
}

child.stdin.write(`${JSON.stringify({ type: "task", task: { taskId: "task-test", source: { id: "source-test" } } })}\n`);
const read = await next();
assert.equal(read.type, "read");
assert.equal(read.sourceId, "source-test");
child.stdin.write(`${JSON.stringify({ type: "evidence", sourceId: "source-test", body: { value: "real" }, sourceUri: "https://api.github.com/repos/example/repo", version: { scheme: "github.body-sha256", token: "v1" } })}\n`);
const answer = await next();
assert.deepEqual(answer, { type: "answer", answer: { value: "real" }, decision: "USE", status: "FRESH" });
child.stdin.write(`${JSON.stringify({ type: "end" })}\n`);
child.stdin.end();
await new Promise((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`candidate exited ${code}`))));
console.log(JSON.stringify({ status: "PASS", testType: "v2-holdout-candidate", networkCalls: 0 }, null, 2));
