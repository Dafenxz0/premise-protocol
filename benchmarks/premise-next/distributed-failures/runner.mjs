import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PostgresValidationFlightStore, validationFlightScopeDigest } from "../../../packages/store-postgres/dist/index.js";
import { InMemoryPostgresAdapter } from "./adapter.mjs";

export const FORMAT = "premise-next/distributed-failures/v1";
export const DEFAULT_SEED = "pr68-deterministic";
export const SCENARIO_IDS = Object.freeze([
  "leader-crash-before-completion",
  "expiry-takeover",
  "old-leader-completion",
  "duplicate-completion",
  "aba-scope-change",
  "tenant-isolation",
  "follower-timeout-abort",
  "receipt-replay"
]);

const TABLE_NAME = "premise_pr68_distributed_failures";
const LEASE_MS = 10;
const RETENTION_MS = 100;

function requiredSeed(seed) {
  if (typeof seed !== "string" || seed.length === 0 || seed.trim() !== seed) throw new TypeError("seed must be a non-empty string");
  return seed;
}

function scope(prefix, name, overrides = {}) {
  const key = `${prefix}:${name}`;
  return {
    tenantId: `tenant:${key}`,
    resourceId: `resource:${key}`,
    incarnationId: `incarnation:${key}`,
    versionScheme: "premise.next.version",
    versionToken: `version:${key}:A`,
    validatorId: `validator:${key}`,
    authorizationContextDigest: `auth:${key}:read`,
    policyDigest: `policy:${key}`,
    queryDigest: `query:${key}`,
    scopes: ["scope:read"],
    changeSetDigest: null,
    causalFrontier: [`frontier:${key}`],
    ...overrides
  };
}

function expectEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
}

function expect(condition, message) {
  assert.equal(condition, true, message);
}

function pass(id, observed) {
  return { id, status: "PASS", observed };
}

async function leaderCrashBeforeCompletion(store, prefix) {
  const flightScope = scope(prefix, "leader-crash");
  const leader = await store.claim(flightScope, "leader:crashed", "flight:crashed", 0, LEASE_MS);
  const follower = await store.claim(flightScope, "follower:waiting", "flight:waiting", 5, LEASE_MS);
  const takeover = await store.claim(flightScope, "leader:replacement", "flight:replacement", 10, LEASE_MS);

  expectEqual(leader.kind, "LEADER", "crashed leader must claim the flight");
  expectEqual(follower.kind, "FOLLOWER", "a live flight must have a follower");
  expectEqual(takeover.kind, "LEADER", "an expired flight must be takeable over");
  expectEqual(takeover.fencingToken, 2, "takeover must advance the fence");

  return pass("leader-crash-before-completion", {
    fault: "completion-skipped",
    leader: leader.kind,
    follower: follower.kind,
    takeover: takeover.kind,
    replacementFence: takeover.fencingToken
  });
}

async function expiryTakeover(store, prefix) {
  const flightScope = scope(prefix, "expiry-takeover");
  const first = await store.claim(flightScope, "leader:first", "flight:first", 0, LEASE_MS);
  const replacement = await store.claim(flightScope, "leader:second", "flight:second", 10, LEASE_MS);
  const completion = await store.complete(flightScope, "leader:second", "flight:second", 2, { answer: "replacement" }, 11, RETENTION_MS);
  const read = await store.read(flightScope, 11);

  expectEqual(first.kind, "LEADER", "initial claim must lead");
  expectEqual(replacement.kind, "LEADER", "expiry must permit takeover");
  expectEqual(replacement.fencingToken, 2, "expiry takeover must be monotonic");
  expectEqual(completion.kind, "COMPLETED", "replacement leader must complete");
  expectEqual(read, { kind: "COMPLETED", fencingToken: 2, receipt: { answer: "replacement" } }, "replacement receipt must be readable");

  return pass("expiry-takeover", {
    firstFence: first.fencingToken,
    replacementFence: replacement.fencingToken,
    completion: completion.kind,
    read: read.kind
  });
}

async function oldLeaderCompletion(store, prefix) {
  const flightScope = scope(prefix, "old-leader");
  const oldLeader = await store.claim(flightScope, "leader:old", "flight:old", 0, LEASE_MS);
  const newLeader = await store.claim(flightScope, "leader:new", "flight:new", 10, LEASE_MS);
  const oldCompletion = await store.complete(flightScope, "leader:old", "flight:old", 1, { answer: "stale" }, 11, RETENTION_MS);
  const newCompletion = await store.complete(flightScope, "leader:new", "flight:new", 2, { answer: "fresh" }, 11, RETENTION_MS);
  const read = await store.read(flightScope, 11);

  expectEqual(oldLeader.kind, "LEADER", "old leader must claim");
  expectEqual(newLeader.kind, "LEADER", "new leader must claim after expiry");
  expectEqual(oldCompletion, { kind: "REJECTED", reason: "FENCED" }, "old leader completion must be fenced");
  expectEqual(newCompletion.kind, "COMPLETED", "new leader completion must succeed");
  expectEqual(read.receipt, { answer: "fresh" }, "stale receipt must not replace fresh receipt");

  return pass("old-leader-completion", {
    oldCompletion: oldCompletion.reason,
    newCompletion: newCompletion.kind,
    finalFence: read.fencingToken,
    receipt: read.receipt.answer
  });
}

async function duplicateCompletion(store, prefix) {
  const flightScope = scope(prefix, "duplicate-completion");
  const claim = await store.claim(flightScope, "leader:one", "flight:one", 0, LEASE_MS);
  const first = await store.complete(flightScope, "leader:one", "flight:one", 1, { answer: 42 }, 1, RETENTION_MS);
  const duplicate = await store.complete(flightScope, "leader:one", "flight:one", 1, { answer: 43 }, 2, RETENTION_MS);
  const read = await store.read(flightScope, 2);

  expectEqual(claim.kind, "LEADER", "duplicate scenario must claim a leader");
  expectEqual(first.kind, "COMPLETED", "first completion must succeed");
  expectEqual(duplicate, { kind: "REJECTED", reason: "FENCED" }, "duplicate completion must be rejected");
  expectEqual(read, { kind: "COMPLETED", fencingToken: 1, receipt: { answer: 42 } }, "first receipt must win");

  return pass("duplicate-completion", {
    first: first.kind,
    duplicate: duplicate.reason,
    retainedAnswer: read.receipt.answer
  });
}

async function abaScopeChange(store, prefix) {
  const scopeA = scope(prefix, "aba", { versionToken: `version:${prefix}:A` });
  const scopeB = { ...scopeA, versionToken: `version:${prefix}:B` };
  const oldA = await store.claim(scopeA, "leader:a-old", "flight:a-old", 0, LEASE_MS);
  const b = await store.claim(scopeB, "leader:b", "flight:b", 1, LEASE_MS);
  const bCompletion = await store.complete(scopeB, "leader:b", "flight:b", 1, { version: "B" }, 2, RETENTION_MS);
  const newA = await store.claim(scopeA, "leader:a-new", "flight:a-new", 10, LEASE_MS);
  const oldACompletion = await store.complete(scopeA, "leader:a-old", "flight:a-old", 1, { version: "old-A" }, 11, RETENTION_MS);
  const newACompletion = await store.complete(scopeA, "leader:a-new", "flight:a-new", 2, { version: "new-A" }, 11, RETENTION_MS);
  const readA = await store.read(scopeA, 11);

  expectEqual(oldA.kind, "LEADER", "first A must claim");
  expectEqual(b.kind, "LEADER", "B must use a separate scope");
  expectEqual(bCompletion.kind, "COMPLETED", "B must complete independently");
  expectEqual(newA.kind, "LEADER", "expired A must be reclaimed");
  expectEqual(newA.fencingToken, 2, "A fence must not reset after B");
  expectEqual(oldACompletion, { kind: "REJECTED", reason: "FENCED" }, "old A completion must fail after A-B-A");
  expectEqual(newACompletion.kind, "COMPLETED", "new A completion must succeed");
  expectEqual(readA.receipt, { version: "new-A" }, "new A receipt must be retained");

  return pass("aba-scope-change", {
    scopes: "A-B-A",
    oldAFence: oldA.fencingToken,
    newAFence: newA.fencingToken,
    oldACompletion: oldACompletion.reason,
    finalReceipt: readA.receipt.version
  });
}

async function tenantIsolation(store, prefix, adapter) {
  const common = scope(prefix, "tenant-isolation");
  const tenantA = { ...common, tenantId: "tenant:alpha" };
  const tenantB = { ...common, tenantId: "tenant:beta" };
  const claimA = await store.claim(tenantA, "leader:alpha", "flight:alpha", 0, LEASE_MS);
  const claimB = await store.claim(tenantB, "leader:beta", "flight:beta", 0, LEASE_MS);
  await store.complete(tenantA, "leader:alpha", "flight:alpha", 1, { tenant: "alpha" }, 1, RETENTION_MS);
  await store.complete(tenantB, "leader:beta", "flight:beta", 1, { tenant: "beta" }, 1, RETENTION_MS);
  const readA = await store.read(tenantA, 2);
  const readB = await store.read(tenantB, 2);

  expectEqual(claimA.kind, "LEADER", "tenant A must claim independently");
  expectEqual(claimB.kind, "LEADER", "tenant B must claim independently");
  expectEqual(claimA.fencingToken, 1, "tenant A fence must start at one");
  expectEqual(claimB.fencingToken, 1, "tenant B fence must start at one");
  expectEqual(readA.receipt, { tenant: "alpha" }, "tenant A must read its own receipt");
  expectEqual(readB.receipt, { tenant: "beta" }, "tenant B must read its own receipt");
  expect(validationFlightScopeDigest(tenantA) !== validationFlightScopeDigest(tenantB), "tenant must participate in the scope digest");

  const tenantContexts = Array.isArray(adapter.tenantContexts)
    ? [...new Set(adapter.tenantContexts.slice(-2))]
    : "server-side set_config";
  return pass("tenant-isolation", {
    independentFences: [claimA.fencingToken, claimB.fencingToken],
    distinctScopeDigests: true,
    receipts: [readA.receipt.tenant, readB.receipt.tenant],
    tenantContexts
  });
}

class SteppingClock {
  constructor(start, step) {
    this.value = start;
    this.step = step;
  }

  now = () => {
    const value = this.value;
    this.value += this.step;
    return value;
  };
}

async function followerTimeoutAbort(store, prefix) {
  const flightScope = scope(prefix, "follower-wait");
  const leader = await store.claim(flightScope, "leader:waiting", "flight:waiting", 0, 100);
  const follower = await store.claim(flightScope, "follower:waiting", "flight:follower", 1, 100);
  const timeoutClock = new SteppingClock(0, 10);
  const timeout = await store.waitForCompletion(flightScope, { now: timeoutClock.now, timeoutMs: 25, pollMs: 0 });
  const abort = await store.waitForCompletion(flightScope, {
    now: () => 0,
    timeoutMs: 100,
    pollMs: 0,
    signal: { aborted: true }
  });
  const read = await store.read(flightScope, 1);

  expectEqual(leader.kind, "LEADER", "timeout scenario must have a leader");
  expectEqual(follower.kind, "FOLLOWER", "timeout scenario must have a follower");
  expectEqual(timeout, { kind: "TIMEOUT" }, "follower timeout must be explicit");
  expectEqual(abort, { kind: "TIMEOUT" }, "aborted follower must stop waiting");
  expectEqual(read.kind, "IN_PROGRESS", "timeout and abort must not complete or take over");

  return pass("follower-timeout-abort", {
    follower: follower.kind,
    timeout: timeout.kind,
    abort: abort.kind,
    flightAfterWait: read.kind
  });
}

async function receiptReplay(store, prefix) {
  const flightScope = scope(prefix, "receipt-replay");
  const receipt = { answer: 42, verdict: "valid", nested: { stable: true } };
  const claim = await store.claim(flightScope, "leader:replay", "flight:replay", 0, LEASE_MS);
  const completion = await store.complete(flightScope, "leader:replay", "flight:replay", 1, receipt, 1, RETENTION_MS);
  const replayClaim = await store.claim(flightScope, "follower:replay", "flight:replay-2", 2, LEASE_MS);
  const replayRead = await store.read(flightScope, 2);
  const replayWait = await store.waitForCompletion(flightScope, { now: () => 2, timeoutMs: 10, pollMs: 0 });

  expectEqual(claim.kind, "LEADER", "replay scenario must claim");
  expectEqual(completion.kind, "COMPLETED", "replay scenario must complete");
  expectEqual(replayClaim, { kind: "COMPLETED", fencingToken: 1, receipt }, "claim must replay the completed receipt");
  expectEqual(replayRead, { kind: "COMPLETED", fencingToken: 1, receipt }, "read must replay the completed receipt");
  expectEqual(replayWait, { kind: "COMPLETED", fencingToken: 1, receipt }, "wait must replay the completed receipt");

  return pass("receipt-replay", {
    claimReplay: replayClaim.kind,
    readReplay: replayRead.kind,
    waitReplay: replayWait.kind,
    fencingToken: replayRead.fencingToken
  });
}

const SCENARIOS = Object.freeze([
  leaderCrashBeforeCompletion,
  expiryTakeover,
  oldLeaderCompletion,
  duplicateCompletion,
  abaScopeChange,
  tenantIsolation,
  followerTimeoutAbort,
  receiptReplay
]);

async function executeScenarios(store, adapter, prefix) {
  const results = [];
  for (const scenario of SCENARIOS) {
    try {
      results.push(await scenario(store, prefix, adapter));
    } catch (error) {
      results.push({
        id: scenario.name,
        status: "FAIL",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

function executionFor(mode) {
  if (mode === "offline-in-memory") {
    return {
      adapter: "in-memory-postgres-adapter-double",
      processesRan: false,
      realPostgresRan: false,
      deterministic: true,
      credentialsRequiredForLive: true
    };
  }
  return {
    adapter: "pg",
    processesRan: false,
    realPostgresRan: true,
    deterministic: false,
    credentialsRequiredForLive: true
  };
}

function limitationsFor(mode) {
  return {
    modeBoundary: mode === "offline-in-memory"
      ? "No process crash, network, or real PostgreSQL is exercised; crash is modeled as skipped completion."
      : "One Node process uses PostgreSQL; this is not multi-process or production-capacity evidence.",
    multiProcessProof: false,
    processCrashProof: false,
    latencyThroughputEvidence: false,
    productionDurabilityEvidence: false,
    liveRequires: ["POSTGRES_URL", "pg"]
  };
}

async function createLiveAdapter(postgresUrl) {
  let pg;
  try {
    pg = await import("pg");
  } catch (error) {
    throw new Error("--live requires the pg package; no offline fallback is used", { cause: error });
  }
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (typeof Pool !== "function") throw new Error("--live requires pg.Pool; no offline fallback is used");
  const pool = new Pool({ connectionString: postgresUrl });
  return new class {
    async query(sql, values) {
      return pool.query(sql, values);
    }

    async transaction(action) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await action({ query: (sql, values) => client.query(sql, values) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the operation error; the client is released below.
        }
        throw error;
      } finally {
        client.release();
      }
    }

    async close() {
      await pool.end();
    }
  }();
}

export async function runCampaign(options = {}) {
  const mode = options.mode ?? "offline";
  const seed = requiredSeed(options.seed ?? DEFAULT_SEED);
  if (mode !== "offline" && mode !== "live") throw new RangeError("mode must be offline or live");

  let adapter;
  let reportMode;
  let prefix = `pr68:${seed}`;
  if (mode === "offline") {
    adapter = new InMemoryPostgresAdapter();
    reportMode = "offline-in-memory";
  } else {
    const postgresUrl = options.postgresUrl ?? process.env.POSTGRES_URL;
    if (typeof postgresUrl !== "string" || postgresUrl.length === 0) throw new Error("--live requires POSTGRES_URL; no offline fallback is used");
    adapter = await createLiveAdapter(postgresUrl);
    prefix = `pr68:live:${randomUUID()}`;
    reportMode = "live-postgres";
  }

  const store = new PostgresValidationFlightStore(adapter, {
    tableName: TABLE_NAME,
    defaultLeaseMs: LEASE_MS,
    completedRetentionMs: RETENTION_MS
  });
  try {
    await store.initialize();
    const scenarios = await executeScenarios(store, adapter, prefix);
    const passed = scenarios.filter((scenario) => scenario.status === "PASS").length;
    return {
      format: FORMAT,
      benchmark: "postgres-validation-flight-failures",
      version: 1,
      seed,
      mode: reportMode,
      execution: executionFor(reportMode),
      summary: {
        scenarioCount: scenarios.length,
        passed,
        failed: scenarios.length - passed
      },
      scenarios,
      limitations: limitationsFor(reportMode)
    };
  } finally {
    await store.close();
  }
}

function parseArguments(argv) {
  const seedArgument = argv.find((argument) => argument.startsWith("--seed="));
  return {
    mode: argv.includes("--live") ? "live" : "offline",
    seed: seedArgument === undefined ? DEFAULT_SEED : seedArgument.slice("--seed=".length),
    pretty: argv.includes("--pretty")
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await runCampaign(options);
    process.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`);
    if (report.summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
