import { readFile } from "node:fs/promises";

const result = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(result.format === "premise-context-corpus-benchmark/0.1", "unexpected benchmark format");
assert(result.runner === "node24", "benchmark must declare Node 24");
assert(result.deterministic === true && result.offline === true, "benchmark must be deterministic and offline");
assert(result.corpus?.cleanedUp === true, "temporary corpus was not cleaned up");
assert(result.corpus?.externalPayloadStoredInProtocol === false, "external payload boundary failed");
assert(result.invariants?.isolation?.passed === true, "unrelated dependency branch was affected");
assert(result.invariants?.topologyCount === 3, "chain, fanout and shared patterns are required");

for (const required of [1000, 10000, 50000]) assert(result.profiles.includes(required), `missing required profile ${required}`);
assert(result.results.length === result.profiles.length * 3, "expected one result for every profile and pattern");

const latencyFields = ["register", "derive", "signal", "check", "validate", "repair", "indexUpdate", "query"];
for (const profile of result.results) {
  assert(profile.nodes >= 1000, `invalid node count for ${profile.pattern}/${profile.profile}`);
  assert(profile.graph.derivedConclusionCount > 0, `no derived conclusions for ${profile.pattern}/${profile.profile}`);
  assert(profile.corpus.externalPayloadBytes > profile.corpus.documentPayloadBytes, "external corpus payload is missing");
  assert(profile.corpus.externalPayloadStoredInProtocol === false, "payload was marked as protocol content");
  assert(profile.corpus.changedDocumentIds.length >= 2, "selective document changes are required");

  assert(profile.checks.before.status === "FRESH" && profile.checks.before.decision === "USABLE", "before check is not usable");
  assert(profile.checks.afterSignal.status === "STALE" && profile.checks.afterSignal.decision === "REVALIDATE", "signal did not propagate STALE");
  assert(profile.checks.afterValidation.status === "INVALID" && profile.checks.afterValidation.decision === "REJECT", "real validation did not invalidate changed context");
  assert(profile.checks.afterRepair.status === "FRESH" && profile.checks.afterRepair.decision === "USABLE", "repair did not restore usability");
  assert(profile.checks.afterRepairAffected.safety === 1 && profile.checks.afterRepairAffected.usable === profile.checks.afterRepairAffected.total, "repair did not restore every affected node");

  assert(profile.propagation.affectedNodes >= profile.corpus.changedDocumentIds.length, "propagation affected fewer nodes than changed documents");
  assert(profile.propagation.repairedDerivedConclusionCount >= 1, "no derived conclusion was repaired");
  if (profile.pattern === "chain" || profile.pattern === "fanout") assert(profile.propagation.affectedNodes === profile.nodes, `${profile.pattern} root change did not reach the full graph`);
  if (profile.pattern === "shared") assert(profile.propagation.affectedNodes < profile.nodes, "shared-support pattern lost selective propagation");

  assert(profile.validator.id === "filesystem" && profile.validator.realFilesystemValidator === true, "FilesystemValidator was not used");
  assert(profile.validator.changedResultCount === profile.corpus.changedDocumentIds.length, "changed documents were not revalidated as CHANGED");
  assert(profile.validator.unchangedControl.result === "UNCHANGED", "unchanged control was falsely changed");

  for (const metricName of ["precision", "safety", "finalSafety", "falseRejectRate", "retrievalHitRate"]) {
    const value = profile.metrics[metricName];
    assert(Number.isFinite(value) && value >= 0 && value <= 1, `invalid ${metricName} for ${profile.pattern}/${profile.profile}`);
  }
  assert(profile.metrics.precision >= 0.95, `precision too low for ${profile.pattern}/${profile.profile}`);
  assert(profile.metrics.safety === 1, `unsafe stale use detected for ${profile.pattern}/${profile.profile}`);
  assert(profile.metrics.finalSafety === 1, `repaired affected node remained unusable for ${profile.pattern}/${profile.profile}`);
  assert(profile.metrics.falseRejectRate === 0, `false reject detected for ${profile.pattern}/${profile.profile}`);
  assert(profile.metrics.retrievalHitRate >= 0.95, `retrieval hit rate too low for ${profile.pattern}/${profile.profile}`);
  assert(profile.queries.final.precision >= 0.95 && profile.queries.final.retrievalHitRate >= 0.95, "final gated retrieval regressed");
  for (const phase of ["preMutation", "postSignal", "final"]) {
    assert(profile.queries[phase].falseRejectUnit === "candidate", `false-reject unit missing in ${phase}`);
    assert(profile.queries[phase].controlQueryCount >= 8 && profile.queries[phase].controlFalseRejectRate === 0, `control query gate failed in ${phase}`);
  }
  assert(profile.queries.postSignal.safety === 1 && profile.queries.postSignal.falseRejectRate === 0, "post-change safety gate failed");
  assert(profile.queries.postSignal.falseRejectDenominator >= 8, "false-reject coverage is too small; control queries are missing");
  assert(profile.queries.final.falseRejectDenominator >= 8, "final false-reject coverage is too small; control queries are missing");

  assert(profile.metrics.metadata.serializedMetadataBytes > 0 && profile.metrics.metadata.payloadStoredInProtocol === false, "metadata metrics are invalid");
  assert(Number.isFinite(profile.metrics.heap.deltaBytes) && profile.metrics.heap.deltaBytes >= 0, "heap metrics are invalid");
  for (const field of latencyFields) {
    const summary = profile.metrics.latency[field];
    assert(summary.count > 0, `missing ${field} latency samples`);
    assert(summary.p50Ms >= 0 && summary.p95Ms >= summary.p50Ms, `invalid ${field} p50/p95`);
  }
}

console.log(JSON.stringify({
  status: "PASS",
  profiles: result.profiles,
  resultCount: result.results.length,
  patterns: result.invariants.dependencyPatterns,
  isolation: result.invariants.isolation,
  metrics: result.results.map((entry) => ({ profile: entry.profile, pattern: entry.pattern, precision: entry.metrics.precision, safety: entry.metrics.safety, finalSafety: entry.metrics.finalSafety, falseRejectRate: entry.metrics.falseRejectRate, retrievalHitRate: entry.metrics.retrievalHitRate }))
}, null, 2));
