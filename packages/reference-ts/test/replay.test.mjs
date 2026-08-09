import assert from "node:assert/strict";
import { EventJournal, eventForRegistration, replayDeterministically } from "../dist/index.js";

const at = "2026-08-09T19:20:00Z";
const envelope = { specVersion: "premise/0.1", memoryId: "memory:replay", provenance: [{ sourceUri: "memory://replay", observedAt: at }], validity: { status: "FRESH", checkedAt: at, policy: "IMMUTABLE" }, dependsOn: [] };
const journal = new EventJournal();
journal.append(eventForRegistration(envelope, "evt-1", at));
journal.append({ specVersion: "premise/0.1", eventId: "evt-2", type: "MemoryStaled", occurredAt: at, memoryId: "memory:replay", payload: { reason: "notification" } });
journal.append({ specVersion: "premise/0.1", eventId: "evt-3", type: "MemoryRevalidated", occurredAt: at, memoryId: "memory:replay", payload: { result: "UNCHANGED", status: "FRESH", version: { scheme: "manual", token: "v1" } } });
assert.equal(journal.history("memory:replay").length, 3);
const replay = replayDeterministically(journal.all());
assert.equal(replay.deterministic, true);
assert.equal(replay.first.memories["memory:replay"].status, "FRESH");
assert.deepEqual(replay.first, replay.second);
console.log("reference-ts event/replay tests passed");
