import { readFile } from "node:fs/promises";

const result = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8"));
if (result.format !== "premise-long-context-benchmark/0.1") throw new Error("unexpected benchmark format");
if (!Array.isArray(result.results) || result.results.length < 6) throw new Error("expected 2 sizes across 3 topologies");
if (result.invariants?.isolation?.passed !== true) throw new Error("signal escaped into an unrelated subgraph");
if (result.invariants.topologyCount !== 3) throw new Error("chain, fanout and shared topologies are required");
for (const profile of result.results) {
  if (!Number.isInteger(profile.nodes) || profile.nodes < 1000) throw new Error(`invalid node count for ${profile.topology}/${profile.count}`);
  if (profile.beforeChangeStatus !== "FRESH") throw new Error(`profile was not fresh before signal: ${profile.topology}/${profile.count}`);
  if (profile.afterSignalStatus !== "STALE") throw new Error(`profile did not become stale after signal: ${profile.topology}/${profile.count}`);
  if (profile.afterValidateStatus !== "FRESH") throw new Error(`profile did not revalidate to fresh: ${profile.topology}/${profile.count}`);
  if (profile.serializedMetadataBytes <= 0 || profile.externalPayloadStoredInProtocol) throw new Error(`metadata/payload boundary failed: ${profile.topology}/${profile.count}`);
  if (profile.affectedNodes < 1) throw new Error(`signal affected no nodes: ${profile.topology}/${profile.count}`);
  if (profile.expectedAffectedNodes !== profile.affectedNodes || profile.unexpectedAffectedNodes !== 0 || profile.missingAffectedNodes !== 0) throw new Error(`signal membership diverged from expected topology: ${profile.topology}/${profile.count}`);
  if (profile.unaffectedAfterValidate.some((item) => item.status !== "FRESH" || item.decision !== "USABLE")) throw new Error(`unaffected branch changed during validation: ${profile.topology}/${profile.count}`);
  if ((profile.topology === "chain" || profile.topology === "fanout") && profile.affectedNodes !== profile.nodes) throw new Error(`${profile.topology} did not propagate through the full graph: ${profile.topology}/${profile.count}`);
  if (profile.topology === "shared" && profile.affectedNodes !== Math.ceil(profile.nodes / 2)) throw new Error(`shared topology did not preserve selective propagation: ${profile.topology}/${profile.count}`);
  if (profile.topology === "shared" && (profile.signalSource !== "long://shared/root-b" || profile.validatedRootId !== "memory:shared:root-b")) throw new Error(`shared benchmark did not signal/validate root-b: ${profile.count}`);
}
const counts = [...new Set(result.results.map((profile) => profile.count))].sort((left, right) => left - right);
if (counts.some((count, index) => index > 0 && count <= counts[index - 1])) throw new Error("profile counts are not monotonic");
console.log(JSON.stringify({ status: "PASS", profileCount: result.results.length, counts, topologies: [...new Set(result.results.map((profile) => profile.topology))], isolation: result.invariants.isolation }));
