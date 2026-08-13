import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAttackBundle, generateAttackFixtures, resolveProfile } from "./index.mjs";
import { runPhysicalTask } from "../runtime/runner.mjs";

function sumCounters(items) {
  const result = {};
  for (const item of items) for (const [key, value] of Object.entries(item?.counters ?? {})) {
    if (typeof value === "number") result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

function chainNodes(count, sourceUri) {
  return Array.from({ length: count }, (_, index) => ({
    id: `memory:attack-${index}`,
    ...(index === 0 ? { sourceUri } : { dependsOn: [`memory:attack-${index - 1}`] })
  }));
}

function sharedSourceNodes(count, sourceUri) {
  return Array.from({ length: count }, (_, index) => ({
    id: `memory:shared-${index}`,
    sourceUri
  }));
}

async function runValidation(profile, seed) {
  if (profile.diagnostic) {
    return {
      status: "DIAGNOSTIC_NOT_RUN",
      reason: "diagnostic node count requires an explicit long-run budget",
      requestedNodeCount: profile.nodeCount
    };
  }
  const sourceUri = `source://attack/validation/${seed}/${profile.name}`;
  const trace = await runPhysicalTask({
    taskId: `attack-validation-${profile.name}`,
    nodes: chainNodes(profile.nodeCount, sourceUri),
    targetIds: ["memory:attack-0"],
    mutation: { sourceUri, token: `v2-${String(seed)}` },
    performAction: false
  });
  return { status: "COMPLETE", mode: "physical-runtime", requestedNodeCount: profile.nodeCount, trace };
}

async function runSingleFlight(profile, seed) {
  const sourceUri = `source://attack/stampede/${seed}/${profile.name}`;
  const count = profile.consumerCount;
  const trace = await runPhysicalTask({
    taskId: `attack-stampede-${profile.name}`,
    nodes: sharedSourceNodes(count, sourceUri),
    targetIds: ["memory:shared-0"],
    mutation: { sourceUri, token: `v2-${String(seed)}` },
    performAction: false
  });
  return { status: "COMPLETE", mode: "physical-runtime", requestedConsumerCount: count, trace };
}

async function runLongHorizon(profile, seed) {
  if (profile.diagnostic) {
    return {
      status: "DIAGNOSTIC_NOT_RUN",
      mode: "physical-runtime-restarts-per-step",
      requestedSteps: profile.horizonSteps,
      requestedNodeCount: profile.nodeCount,
      steps: 0,
      counters: {},
      reason: "diagnostic horizon requires an explicit long-run budget"
    };
  }
  const traces = [];
  for (let step = 0; step < profile.horizonSteps; step += 1) {
    const sourceUri = `source://attack/horizon/${seed}/${profile.name}/${step}`;
    traces.push(await runPhysicalTask({
      taskId: `attack-horizon-${profile.name}-${step}`,
      nodes: chainNodes(profile.nodeCount, sourceUri),
      targetIds: ["memory:attack-0"],
      mutation: { sourceUri, token: `v${step + 2}-${String(seed)}` },
      performAction: false,
      deliverEvents: step % 5 !== 4,
      commit: `seed:${seed}`
    }));
  }
  return {
    status: "COMPLETE_REPEATED_TASKS",
    mode: "physical-runtime-restarts-per-step",
    requestedSteps: profile.horizonSteps,
    requestedNodeCount: profile.nodeCount,
    steps: traces.length,
    counters: sumCounters(traces)
  };
}

export async function runAttackSmoke(options = {}) {
  const profile = resolveProfile(options.profile ?? "smoke");
  const seed = options.seed ?? 20260813;
  const fixtures = generateAttackFixtures({ profile: profile.name, seed });
  const publicHashes = Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, fixture.publicHash]));
  const validation = await runValidation(profile, seed);
  const stampede = await runSingleFlight(profile, seed);
  const horizon = await runLongHorizon(profile, seed);
  const receipt = generateAttackBundle("receipt-cache-adversarial", { profile: profile.name, seed });
  return Object.freeze({
    format: "premise-efficiency-lab/v1/attack-report",
    status: "COMPLETE_WITH_NOT_RUN_DIMENSION",
    profile: profile.name,
    seed,
    publicHashes,
    validationAmplification: { status: validation.status, counters: validation.trace?.counters ?? {}, decisions: validation.trace?.decisions?.length ?? "UNKNOWN", requestedNodeCount: validation.requestedNodeCount },
    singleFlightStampede: { status: stampede.status, consumerCount: stampede.requestedConsumerCount, counters: stampede.trace?.counters ?? {} },
    longHorizonDrift: horizon,
    receiptCacheAdversarial: { status: "NOT_RUN", reason: "runtime receipt/cache implementation is not yet enabled", publicFixtureHash: receipt.public?.publicHash ?? receipt.publicHash },
    gates: {
      noUnsafeActionsInPhysicalSmoke: profile.diagnostic ? "UNKNOWN" : true,
      receiptCacheGate: "NOT_RUN",
      diagnosticScale: profile.diagnostic
    }
  });
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const args = Object.fromEntries(process.argv.slice(2).map((value) => {
    const [key, raw] = value.replace(/^--/, "").split("=");
    return [key, raw === undefined ? true : (/^\d+$/.test(raw) ? Number(raw) : raw)];
  }));
  const report = await runAttackSmoke({ profile: args.profile ?? "smoke", seed: args.seed ?? 20260813 });
  const output = resolve(args.output ?? `.tmp/premise-efficiency-lab/v1/attacks-${report.profile}`);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "attack-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, output, profile: report.profile }, null, 2)}\n`);
}
