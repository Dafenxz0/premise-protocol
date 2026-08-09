import assert from "node:assert/strict";
import { ReferenceProtocol } from "../dist/index.js";

const at = "2026-08-09T19:20:00Z";
const base = (memoryId, status = "FRESH", dependsOn = []) => ({ specVersion: "premise/0.1", memoryId, provenance: [{ sourceUri: `file://${memoryId}`, observedAt: at, version: { scheme: "test", token: "v1" }, validator: { id: "test", operation: "read" } }], validity: { status, checkedAt: at, policy: "VERSIONED" }, dependsOn });
const protocol = new ReferenceProtocol();
protocol.register(base("a"));
protocol.register(base("unrelated"));
protocol.derive({ ...base("b"), validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" }, dependsOn: ["a"] });
protocol.registerValidator({ id: "test", validate: async (source) => ({ memoryId: "a", result: source.version.token === "v1" ? "UNCHANGED" : "CHANGED", status: source.version.token === "v1" ? "FRESH" : "INVALID", checkedAt: at, version: source.version }) });
protocol.signal({ specVersion: "premise/0.1", eventId: "source-1", type: "SourceChanged", occurredAt: at, payload: { sourceUri: "file://a", version: { scheme: "test", token: "v2" } } });
assert.equal(protocol.check(["a"]).items[0].decision, "REVALIDATE");
assert.equal(protocol.check(["b"]).items[0].decision, "REVALIDATE");
assert.equal(protocol.check(["unrelated"]).items[0].decision, "USABLE");
const report = await protocol.validate(["a"], { a: { memoryId: "a", result: "UNCHANGED", status: "FRESH", checkedAt: at, version: { scheme: "test", token: "v2" } } });
assert.equal(report.items[0].status, "FRESH");
assert.equal(protocol.check(["b"]).items[0].decision, "USABLE");
assert.ok(protocol.history("a").length >= 3);
console.log("reference-ts validation tests passed");
