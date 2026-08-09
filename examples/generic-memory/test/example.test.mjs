import assert from "node:assert/strict";
import { GenericMemoryAdapter, runGenericExample } from "../dist/index.js";

const result = await runGenericExample();
assert.equal(result.status, "FRESH");
assert.deepEqual(result.content, { answer: 42 });
const adapter = new GenericMemoryAdapter();
assert.deepEqual(adapter.capabilities.capabilities, ["RECORD", "DEPENDENCY", "REVALIDATION", "RETRIEVAL", "GATE"]);
console.log("generic-memory example passed");
