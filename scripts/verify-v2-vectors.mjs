import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isMemoryEnvelopeV2, isV2Event, isV2OperationRequest } from "../packages/protocol-types/dist/index.js";

const manifest = JSON.parse(await readFile(new URL("../spec/v2/test-vectors/manifest.json", import.meta.url), "utf8"));
for (const vector of manifest.vectors) {
  const input = JSON.parse(await readFile(new URL(`../spec/v2/test-vectors/${vector.file}`, import.meta.url), "utf8"));
  const valid = vector.kind === "envelope" ? isMemoryEnvelopeV2(input) : vector.kind === "operation" ? isV2OperationRequest(input) : isV2Event(input);
  assert.equal(valid, vector.valid, `v2 vector ${vector.id}`);
}
console.log(`PREMiSE v2 vectors passed (${manifest.vectors.length})`);
