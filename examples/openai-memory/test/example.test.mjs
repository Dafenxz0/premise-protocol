import assert from "node:assert/strict";
import { runOpenAIMemoryExample } from "../dist/index.js";

const result = await runOpenAIMemoryExample();
assert.equal(result.decision, "REVALIDATE");
assert.deepEqual(result.content, { provider: "openai", fact: "stable" });
console.log("openai-memory example passed");
