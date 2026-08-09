import assert from "node:assert/strict";
import { DeterministicClock, SeededRandom, assertAcyclic, generateMemoryEnvelope, runProperties } from "../dist/index.js";

const clock = new DeterministicClock();
assert.equal(clock.now(), "2026-08-09T00:00:00.000Z");
assert.equal(clock.advance(1000), "2026-08-09T00:00:01.000Z");
const randomA = new SeededRandom(42);
const randomB = new SeededRandom(42);
assert.equal(randomA.next(), randomB.next());
assert.equal(generateMemoryEnvelope(1).memoryId, "memory:test-1");
assert.doesNotThrow(() => assertAcyclic({ a: ["b"], b: [] }));
assert.throws(() => assertAcyclic({ a: ["b"], b: ["a"] }), /cycle/);
const report = runProperties({ clock: () => assert.equal(clock.now(), "2026-08-09T00:00:01.000Z"), ids: () => assert.equal(generateMemoryEnvelope(2).memoryId, "memory:test-2") });
assert.deepEqual(report.failed, []);
assert.equal(report.passed, 2);
console.log("testkit tests passed");
