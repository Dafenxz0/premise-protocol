import assert from "node:assert/strict";
import { runMcpMemoryExample } from "../dist/index.js";

assert.equal(await runMcpMemoryExample(), "REJECT");
console.log("mcp-memory example passed");
