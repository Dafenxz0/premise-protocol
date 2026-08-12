import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FORMAT = "premise-protocol-evolution-benchmark/1";
export const SEED = "premise-protocol-evolution-v1";

const OUTPUT_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));
const WORK_FIELDS = Object.freeze([
  "sourceReads",
  "validationCalls",
  "guardChecks",
  "conditionalChecks",
  "commits",
  "effects",
  "invalidations",
  "revalidations",
  "sharedHits",
  "snapshotReads"
]);

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function percent(part, total) {
  return total === 0 ? 0 : Number(((part * 100) / total).toFixed(2));
}

function work(overrides = {}) {
  return Object.fromEntries(WORK_FIELDS.map((field) => [field, overrides[field] ?? 0]));
}

function sumWork(traces) {
  const total = work();
  for (const trace of traces) {
    for (const field of WORK_FIELDS) total[field] += trace.physicalWork[field];
  }
  total.totalOperations = WORK_FIELDS.reduce((sum, field) => sum + total[field], 0);
  return total;
}

function trace({ caseId, safe, outcome, reason, physicalWork, details = {}, unnecessaryRevalidation = false }) {
  return {
    caseId,
    safe,
    outcome,
    reason,
    unnecessaryRevalidation,
    ...details,
    physicalWork: work(physicalWork)
  };
}

function finishStrategy(meta, traces) {
  const safeOutcomes = traces.filter((item) => item.safe).length;
  const unsafeOutcomes = traces.length - safeOutcomes;
  const unsafeEffects = traces.reduce((sum, item) => sum + (item.safe ? 0 : item.physicalWork.effects), 0);
  const unnecessaryRevalidations = traces.filter((item) => item.unnecessaryRevalidation).length;
  return {
    ...meta,
    cases: traces,
    safety: {
      attempts: traces.length,
      safeOutcomes,
      unsafeOutcomes,
      safetyRatePercent: percent(safeOutcomes, traces.length),
      unsafeEffects,
      unnecessaryRevalidations
    },
    physicalWork: sumWork(traces)
  };
}

function identity(tenantId, incarnationId, observationId) {
  return {
    tenantId,
    resourceId: "doc:7",
    incarnationId,
    versionToken: "A",
    observationId
  };
}

const IDENTITY_CASES = Object.freeze([
  {
    id: "unchanged-observation",
    receipt: identity("tenant:a", "inc:1", "obs:1"),
    current: identity("tenant:a", "inc:1", "obs:1"),
    expectedUse: true
  },
  {
    id: "aba-delete-recreate",
    receipt: identity("tenant:a", "inc:1", "obs:1"),
    current: identity("tenant:a", "inc:2", "obs:2"),
    expectedUse: false
  },
  {
    id: "cross-tenant-replay",
    receipt: identity("tenant:a", "inc:1", "obs:1"),
    current: identity("tenant:b", "inc:1", "obs:1"),
    expectedUse: false
  }
]);

function sameIdentity(left, right) {
  return ["tenantId", "resourceId", "incarnationId", "versionToken", "observationId"]
    .every((field) => left[field] === right[field]);
}

function sameTenantResourceVersion(left, right) {
  return ["tenantId", "resourceId", "versionToken"].every((field) => left[field] === right[field]);
}

function buildIdentityScenario() {
  const run = (mode) => finishStrategy(
    mode === "weak"
      ? {
          strategy: "tenant-resource-version",
          baseline: true,
          protocol: "simple-baseline",
          description: "Matches tenant, resource and version; ignores incarnation and observation identity."
        }
      : {
          strategy: "full-identity",
          baseline: false,
          protocol: "premise/1.1-reference",
          description: "Matches all five identity fields, including incarnation and observation."
        },
    IDENTITY_CASES.map((item) => {
      const matches = mode === "weak"
        ? sameTenantResourceVersion(item.receipt, item.current)
        : sameIdentity(item.receipt, item.current);
      return trace({
        caseId: item.id,
        safe: matches === item.expectedUse,
        outcome: matches ? "USE" : "REJECT",
        reason: item.expectedUse
          ? "EXACT_IDENTITY_MATCH"
          : matches
            ? "WEAK_IDENTITY_ACCEPTED"
            : "IDENTITY_MISMATCH",
        physicalWork: { sourceReads: 1, validationCalls: 1 },
        details: { matched: matches }
      });
    })
  );

  return {
    id: "identity-aba",
    title: "Identity and ABA",
    category: "safety",
    question: "Can a receipt survive delete/recreate or cross-tenant identity reuse?",
    caseCount: IDENTITY_CASES.length,
    strategies: [run("weak"), run("full")]
  };
}

const SCOPED_INVALIDATION_CASES = Object.freeze([
  {
    id: "unrelated-metadata-change",
    receiptScopes: ["/head"],
    changedScopes: ["/metadata"],
    expectedUse: true
  },
  {
    id: "dependent-head-change",
    receiptScopes: ["/head"],
    changedScopes: ["/head"],
    expectedUse: false
  }
]);

function buildScopedInvalidationScenario() {
  const run = (mode) => finishStrategy(
    mode === "wide"
      ? {
          strategy: "resource-wide-invalidation",
          baseline: true,
          protocol: "simple-baseline",
          description: "Invalidates every cached decision for the resource after any scope change."
        }
      : {
          strategy: "scope-aware-invalidation",
          baseline: false,
          protocol: "premise/1.1-reference",
          description: "Invalidates only when a changed scope equals a scope in the receipt."
        },
    SCOPED_INVALIDATION_CASES.map((item) => {
      const affected = mode === "wide"
        || item.changedScopes.some((changed) => item.receiptScopes.includes(changed));
      const outcome = affected ? "REVALIDATE" : "USE";
      const safe = item.expectedUse ? true : outcome !== "USE";
      return trace({
        caseId: item.id,
        safe,
        outcome,
        reason: affected ? "DEPENDENCY_SCOPE_CHANGED" : "CHANGED_SCOPE_UNRELATED",
        unnecessaryRevalidation: item.expectedUse && affected,
        physicalWork: {
          sourceReads: affected ? 1 : 0,
          validationCalls: 1,
          invalidations: affected ? 1 : 0,
          revalidations: affected ? 1 : 0
        },
        details: { affected }
      });
    })
  );

  return {
    id: "scoped-invalidation",
    title: "Scoped invalidation",
    category: "safety + work",
    question: "Does an unrelated scope preserve reuse while a dependent scope forces revalidation?",
    caseCount: SCOPED_INVALIDATION_CASES.length,
    strategies: [run("wide"), run("scoped")]
  };
}

const SHARING_BASE = Object.freeze({
  tenantId: "tenant:a",
  resourceId: "doc:7",
  incarnationId: "inc:1",
  validator: "validator:v1",
  authorization: "reader",
  policy: "policy:read-safe"
});

const SHARING_REQUESTS = Object.freeze([
  { id: "request-a1", ...SHARING_BASE, scopes: ["/head"], frontier: ["/head"] },
  { id: "request-a2", ...SHARING_BASE, scopes: ["/head"], frontier: ["/head"] },
  { id: "request-a3", ...SHARING_BASE, scopes: ["/head"], frontier: ["/head"] },
  { id: "request-b1", ...SHARING_BASE, scopes: ["/checks"], frontier: ["/checks"] }
]);

function sharingKey(request) {
  return stableStringify({
    tenantId: request.tenantId,
    resourceId: request.resourceId,
    incarnationId: request.incarnationId,
    scopes: request.scopes,
    validator: request.validator,
    authorization: request.authorization,
    policy: request.policy,
    frontier: request.frontier
  });
}

function resourceKey(request) {
  return stableStringify({ tenantId: request.tenantId, resourceId: request.resourceId });
}

function buildSharingScenario() {
  const run = (mode) => {
    const meta = mode === "none"
      ? {
          strategy: "no-sharing",
          baseline: true,
          protocol: "simple-baseline",
          description: "Validates every request independently."
        }
      : mode === "resource"
        ? {
            strategy: "resource-only-sharing",
            baseline: true,
            protocol: "simple-baseline",
            description: "Shares by tenant and resource only; it ignores scope and policy identity."
          }
        : {
            strategy: "exact-key-single-flight",
            baseline: false,
            protocol: "premise-policy/1-reference",
            description: "One owner per complete sharing key; waiters reuse only an exact receipt."
          };
    const owners = new Map();
    const traces = SHARING_REQUESTS.map((request) => {
      const key = mode === "none" ? request.id : mode === "resource" ? resourceKey(request) : sharingKey(request);
      const owner = owners.get(key);
      if (!owner) {
        owners.set(key, request);
        return trace({
          caseId: request.id,
          safe: true,
          outcome: "OWNER_VALIDATE",
          reason: "SINGLE_FLIGHT_OWNER",
          physicalWork: { sourceReads: 1, validationCalls: 1 },
          details: { sharingKey: key }
        });
      }
      const exact = sharingKey(owner) === sharingKey(request);
      return trace({
        caseId: request.id,
        safe: exact,
        outcome: exact ? "RECEIPT_SHARED" : "SCOPE_MISMATCH_SHARED",
        reason: exact ? "EXACT_SHARING_KEY" : "SHARING_SCOPE_MISMATCH",
        physicalWork: { sharedHits: 1 },
        details: { sharingKey: key, owner: owner.id }
      });
    });
    return finishStrategy(meta, traces);
  };

  return {
    id: "receipt-sharing-single-flight",
    title: "Receipt sharing and single-flight",
    category: "safety + work",
    question: "Can concurrent work share a receipt without crossing scope, policy or frontier boundaries?",
    caseCount: SHARING_REQUESTS.length,
    strategies: [run("none"), run("resource"), run("exact")]
  };
}

const COHERENCE_CASES = Object.freeze([
  { id: "stable-members", mutationBetweenReads: false },
  { id: "mutation-between-members", mutationBetweenReads: true }
]);

function buildCoherenceScenario() {
  const memberByMember = finishStrategy(
    {
      strategy: "naive-member-reads",
      baseline: true,
      protocol: "simple-baseline",
      description: "Reads members separately and publishes without binding them to one event head."
    },
    COHERENCE_CASES.map((item) => {
      const eventHeads = item.mutationBetweenReads ? ["event:0", "event:1"] : ["event:0", "event:0"];
      const coherent = eventHeads[0] === eventHeads[1];
      return trace({
        caseId: item.id,
        safe: coherent,
        outcome: "USE",
        reason: coherent ? "COINCIDENTAL_SAME_EVENT_HEAD" : "MIXED_EVENT_HEADS_ACCEPTED",
        physicalWork: { sourceReads: 2, validationCalls: 1 },
        details: { eventHeads, coherent }
      });
    })
  );

  const coherentSnapshot = finishStrategy(
    {
      strategy: "transactional-snapshot",
      baseline: false,
      protocol: "premise/1.1-reference",
      description: "Captures all members at one causal point before producing a coherent result."
    },
    COHERENCE_CASES.map((item) => trace({
      caseId: item.id,
      safe: true,
      outcome: "USE",
      reason: "ATOMIC_CAUSAL_SNAPSHOT",
      physicalWork: { snapshotReads: 1, validationCalls: 1 },
      details: { snapshotEventHead: "event:0", coherent: true }
    }))
  );

  return {
    id: "coherence",
    title: "Causal coherence",
    category: "safety + work",
    question: "Does a multi-member read reject mixed event heads or bind all members to one snapshot?",
    caseCount: COHERENCE_CASES.length,
    strategies: [memberByMember, coherentSnapshot]
  };
}

const GUARD_CASES = Object.freeze([
  { id: "unchanged-before-commit", mutationBeforeCommit: false },
  { id: "mutation-after-validation", mutationBeforeCommit: true }
]);

function buildGuardScenario() {
  const readThenWrite = finishStrategy(
    {
      strategy: "read-then-write",
      baseline: true,
      protocol: "simple-baseline",
      description: "Checks a revision, then writes unconditionally."
    },
    GUARD_CASES.map((item) => trace({
      caseId: item.id,
      safe: !item.mutationBeforeCommit,
      outcome: "COMMITTED",
      reason: item.mutationBeforeCommit ? "TOCTOU_UNCHECKED" : "REVISION_UNCHANGED",
      physicalWork: { sourceReads: 1, guardChecks: 1, commits: 1, effects: 1 },
      details: { observedRevision: 1, revisionAtCommit: item.mutationBeforeCommit ? 2 : 1 }
    }))
  );

  const conditionalCas = finishStrategy(
    {
      strategy: "conditional-CAS",
      baseline: false,
      protocol: "premise-guard/1-reference",
      description: "Commits only when the observed identity and revision still match atomically."
    },
    GUARD_CASES.map((item) => {
      const committed = !item.mutationBeforeCommit;
      return trace({
        caseId: item.id,
        safe: true,
        outcome: committed ? "COMMITTED" : "REJECTED",
        reason: committed ? "CAS_MATCH" : "VERSION_MISMATCH_NO_EFFECT",
        physicalWork: {
          sourceReads: 1,
          guardChecks: 1,
          conditionalChecks: 1,
          commits: 1,
          effects: committed ? 1 : 0
        },
        details: { observedRevision: 1, revisionAtCommit: item.mutationBeforeCommit ? 2 : 1 }
      });
    })
  );

  return {
    id: "guard-toctou",
    title: "Guard TOCTOU",
    category: "safety + physical work",
    question: "Does a mutation after validation cause an effect, or does conditional commit fail closed?",
    caseCount: GUARD_CASES.length,
    strategies: [readThenWrite, conditionalCas]
  };
}

function buildScenarios() {
  return [
    buildIdentityScenario(),
    buildScopedInvalidationScenario(),
    buildSharingScenario(),
    buildCoherenceScenario(),
    buildGuardScenario()
  ];
}

function aggregateOverview(scenarios) {
  const rows = scenarios.flatMap((scenario) => scenario.strategies);
  const referenceRows = rows.filter((row) => !row.baseline);
  const baselineRows = rows.filter((row) => row.baseline);
  const sum = (items, path) => items.reduce((total, item) => total + path(item), 0);
  const referenceAttempts = sum(referenceRows, (row) => row.safety.attempts);
  const baselineAttempts = sum(baselineRows, (row) => row.safety.attempts);
  const referenceSafe = sum(referenceRows, (row) => row.safety.safeOutcomes);
  const baselineUnsafe = sum(baselineRows, (row) => row.safety.unsafeOutcomes);
  return {
    scenarioCount: scenarios.length,
    caseCount: sum(scenarios, (scenario) => scenario.caseCount),
    strategyRows: rows.length,
    referenceRows: referenceRows.length,
    baselineRows: baselineRows.length,
    referenceUnsafeOutcomes: referenceAttempts - referenceSafe,
    referenceSafetyRatePercent: percent(referenceSafe, referenceAttempts),
    baselineUnsafeOutcomes: baselineUnsafe,
    baselineSafetyRatePercent: percent(baselineAttempts - baselineUnsafe, baselineAttempts)
  };
}

export function buildBenchmark() {
  const scenarios = buildScenarios();
  return {
    format: FORMAT,
    benchmark: "protocol-evolution",
    version: 1,
    mode: "offline-deterministic",
    seed: SEED,
    execution: {
      networkAccess: false,
      externalDependencies: [],
      wallClockConsulted: false,
      randomnessConsulted: false,
      mutableExternalState: false
    },
    measurement: {
      unit: "integer operation counts",
      safety: "An outcome is safe only when it respects the scenario invariant; unsafe effects are counted separately.",
      physicalWork: "Counts simulated authoritative reads, validation calls, guard checks, conditional checks, commits, effects, invalidations, revalidations, shared hits and snapshot reads.",
      totalOperations: "The sum of the named operation counts; it is a transparent work count, not a cost model.",
      notMeasured: ["elapsed time", "latency", "money", "energy", "provider billing", "capacity"]
    },
    claims: {
      eligibleForPublicProductClaim: false,
      reason: "This is a deterministic protocol model, not production or provider performance evidence."
    },
    overview: aggregateOverview(scenarios),
    scenarios
  };
}

function formatWork(physicalWork) {
  const labels = [
    ["sourceReads", "reads"],
    ["validationCalls", "validations"],
    ["guardChecks", "guard"],
    ["conditionalChecks", "CAS"],
    ["commits", "commits"],
    ["effects", "effects"],
    ["invalidations", "invalidations"],
    ["revalidations", "revalidations"],
    ["sharedHits", "shared hits"],
    ["snapshotReads", "snapshots"],
    ["totalOperations", "total"]
  ];
  return labels.map(([field, label]) => `${label}=${physicalWork[field]}`).join(", ");
}

function formatCases(strategy) {
  return strategy.cases.map((item) => `${item.caseId}:${item.safe ? "safe" : "UNSAFE"}`).join("; ");
}

export function renderReport(summary) {
  const scenarioSections = summary.scenarios.map((scenario) => {
    const rows = scenario.strategies.map((strategy) => `| ${strategy.strategy} | ${strategy.baseline ? "yes" : "no"} | ${strategy.safety.safeOutcomes}/${strategy.safety.attempts} safe; ${strategy.safety.unsafeOutcomes} unsafe; ${strategy.safety.unsafeEffects} unsafe effects | ${formatWork(strategy.physicalWork)} | ${formatCases(strategy)} |`).join("\n");
    return `## ${scenario.title}

${scenario.question}

| Strategy | Baseline | Safety | Physical work | Case outcomes |
|---|:---:|---|---|---|
${rows}
`;
  }).join("\n");

  return `# PREMiSE protocol-evolution benchmark

Format: **${summary.format}**<br>
Mode: **${summary.mode}**<br>
Seed: **${summary.seed}**<br>
Cases: **${summary.overview.caseCount}** across **${summary.overview.scenarioCount}** scenarios

## What this measures

The benchmark is an offline, deterministic comparison of simple baselines and
reference policies for identity ABA, scoped invalidation, receipt sharing and
single-flight, causal coherence, and guard TOCTOU.

Safety is an outcome property: a baseline is marked unsafe when it permits an
operation that violates the scenario invariant. The reference rows must have
zero unsafe outcomes. Physical work is reported as integer counts of simulated
operations. It is not converted into time, money, energy, capacity, or provider
billing.

Execution uses no network, clock, randomness, external dependency, or mutable
external state. Run it with:

\`\`\`text
node benchmarks/protocol-evolution/runner.mjs
node benchmarks/protocol-evolution/self-check.mjs
\`\`\`

Reference rows: **${summary.overview.referenceUnsafeOutcomes} unsafe outcomes**
across ${summary.overview.referenceRows} rows (${summary.overview.referenceSafetyRatePercent}% safe).
Baseline rows: **${summary.overview.baselineUnsafeOutcomes} unsafe outcomes**
across ${summary.overview.baselineRows} rows (${summary.overview.baselineSafetyRatePercent}% safe).

${scenarioSections}
## Reading the result

- \`sourceReads\`, \`validationCalls\`, \`guardChecks\`, \`conditionalChecks\`,
  \`commits\`, \`effects\`, \`invalidations\`, \`revalidations\`, \`sharedHits\`, and
  \`snapshotReads\` are physical operation counts from this model.
- \`total\` is their sum, with no weighting and no monetary interpretation.
- A safe row may still do more work (for example, wide invalidation); safety is
  evaluated before work is compared.

## Limits

This benchmark proves only that the deterministic scenarios distinguish the
declared policies under the modeled events. It does not measure production
latency, durability, throughput, hardware, cloud billing, or the truth of an
external source.
`;
}

export async function writeArtifacts(summary = buildBenchmark()) {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(new URL("./summary.json", import.meta.url), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(new URL("./report.md", import.meta.url), renderReport(summary), "utf8");
}

async function main() {
  const summary = buildBenchmark();
  await writeArtifacts(summary);
  console.log(`protocol-evolution benchmark: ${summary.overview.caseCount} cases, ${summary.overview.scenarioCount} scenarios, ${summary.overview.referenceUnsafeOutcomes} reference unsafe outcomes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
