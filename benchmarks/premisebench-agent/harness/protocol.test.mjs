import test from "node:test";
import assert from "node:assert/strict";
import { assertAgentSafe, parseCandidateMessage, startMessage } from "./protocol.mjs";

test("candidate start message contains no evaluator oracle", () => {
  const message = startMessage({ taskId: "task-1", source: "filesystem:config", memory: { version: "v1", content: { status: "active" } } });
  assert.equal(message.tools.includes("read"), true);
  assert.throws(() => assertAgentSafe({ expected: "active" }), /oracle field/);
  assert.deepEqual(parseCandidateMessage({ protocol: "premisebench-agent/1", type: "read" }).type, "read");
});
