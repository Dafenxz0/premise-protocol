import { pathToFileURL } from "node:url";

export const WORKER_COUNT = 100;
export const DEFAULT_SEED = "premise-next-storm-20260814";
const VERSION_SCHEME = "storm";

const METRIC_NAMES = [
  "physicalValidations",
  "joins",
  "crossTenantShares",
  "crossScopeShares",
  "staleOutcomes",
  "unknownOutcomes",
  "sideEffectAttempts",
  "sideEffectCommits",
  "staleAccepted",
  "oldFenceCommits",
  "crossTenantSideEffectCommits",
  "fenceRejectedAttempts",
  "eventSignals",
  "leaseExpiries",
  "timeoutSignals",
  "elapsedMs"
];

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function cloneVersion(version) {
  return { scheme: version.scheme, token: version.token };
}

function sameVersion(left, right) {
  return left?.scheme === right?.scheme && left?.token === right?.token;
}

function version(label, incarnation) {
  return { scheme: VERSION_SCHEME, token: `${label}@${incarnation}` };
}

function requestKey(request) {
  return JSON.stringify([
    request.tenantId,
    request.resource,
    request.expectedVersion.scheme,
    request.expectedVersion.token,
    request.authorizationScope
  ]);
}

function fenceScope(request) {
  return JSON.stringify([request.tenantId, request.resource, request.authorizationScope]);
}

function unknown(fencingToken, reason) {
  return { result: "UNKNOWN", fencingToken, reason };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

class VirtualClock {
  #now = 0;

  now() {
    return this.#now;
  }

  advance(milliseconds) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError("virtual time must advance by a non-negative integer");
    this.#now += milliseconds;
  }
}

class InMemoryWorld {
  constructor(clock, metrics) {
    this.clock = clock;
    this.metrics = metrics;
    this.states = new Map();
    this.gates = new Map();
  }

  #stateKey(tenantId, resource) {
    return JSON.stringify([tenantId, resource]);
  }

  seed({ tenantId, resource, label = "A", incarnation = 1, readScopes = ["scope:read", "scope:write"], actionScopes = ["scope:write"] }) {
    const key = this.#stateKey(tenantId, resource);
    this.states.set(key, {
      tenantId,
      resource,
      label,
      incarnation,
      version: version(label, incarnation),
      readScopes: new Set(readScopes),
      actionScopes: new Set(actionScopes),
      value: { tenantId, resource, label, incarnation }
    });
  }

  mutate({ tenantId, resource, label }) {
    const state = this.states.get(this.#stateKey(tenantId, resource));
    if (state === undefined) throw new Error(`cannot mutate unknown source ${tenantId}/${resource}`);
    state.incarnation += 1;
    state.label = requiredString(label, "label");
    state.version = version(state.label, state.incarnation);
    state.value = { tenantId, resource, label: state.label, incarnation: state.incarnation };
  }

  snapshot(tenantId, resource) {
    const state = this.states.get(this.#stateKey(tenantId, resource));
    if (state === undefined) return undefined;
    return {
      tenantId: state.tenantId,
      resource: state.resource,
      version: cloneVersion(state.version),
      value: { ...state.value },
      readScopes: new Set(state.readScopes),
      actionScopes: new Set(state.actionScopes)
    };
  }

  blockNext(request, predicate = () => true) {
    const key = requestKey(request);
    const gate = deferred();
    const entries = this.gates.get(key) ?? [];
    entries.push({ gate, predicate });
    this.gates.set(key, entries);
    return gate;
  }

  async validate(input) {
    this.metrics.physicalValidations += 1;
    this.metrics.physicalValidationKeys.add(requestKey(input));
    this.clock.advance(5);

    const key = requestKey(input);
    const entries = this.gates.get(key) ?? [];
    const gateIndex = entries.findIndex((entry) => entry.predicate(input));
    if (gateIndex >= 0) {
      const [{ gate }] = entries.splice(gateIndex, 1);
      if (entries.length === 0) this.gates.delete(key);
      await gate.promise;
    }

    const state = this.snapshot(input.tenantId, input.resource);
    if (state === undefined || !state.readScopes.has(input.authorizationScope)) {
      return unknown(input.fencingToken, "SOURCE_UNKNOWN");
    }

    return {
      result: sameVersion(state.version, input.expectedVersion) ? "UNCHANGED" : "CHANGED",
      fencingToken: input.fencingToken,
      version: state.version,
      value: state.value
    };
  }

  canAct(request) {
    const state = this.states.get(this.#stateKey(request.tenantId, request.resource));
    return state !== undefined && state.actionScopes.has(request.authorizationScope);
  }
}

class StormCoordinator {
  constructor(world, clock, metrics) {
    this.world = world;
    this.clock = clock;
    this.metrics = metrics;
    this.flights = new Map();
    this.liveFlights = new Set();
    this.latestFence = new Map();
    this.cancelledFences = new Set();
    this.nextFencingToken = 0;
  }

  #normalize(input) {
    if (input === undefined || input === null) throw new TypeError("validation request is required");
    const tenantId = requiredString(input.tenantId, "tenantId");
    const resource = requiredString(input.resource, "resource");
    const authorizationScope = requiredString(input.authorizationScope, "authorizationScope");
    const scheme = requiredString(input.expectedVersion?.scheme, "expectedVersion.scheme");
    const token = requiredString(input.expectedVersion?.token, "expectedVersion.token");
    return { tenantId, resource, authorizationScope, expectedVersion: { scheme, token } };
  }

  validate(input) {
    const request = this.#normalize(input);
    const key = requestKey(request);
    const scope = fenceScope(request);
    this.clock.advance(1);

    const existing = this.flights.get(key);
    if (existing !== undefined && existing.active && this.latestFence.get(scope) === existing.fencingToken) {
      this.metrics.joins += 1;
      if (existing.tenantId !== request.tenantId) this.metrics.crossTenantShares += 1;
      if (existing.authorizationScope !== request.authorizationScope) this.metrics.crossScopeShares += 1;
      existing.joiners += 1;
      return existing.promise;
    }

    const fencingToken = ++this.nextFencingToken;
    this.latestFence.set(scope, fencingToken);
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    const flight = {
      key,
      scope,
      tenantId: request.tenantId,
      resource: request.resource,
      authorizationScope: request.authorizationScope,
      expectedVersion: request.expectedVersion,
      fencingToken,
      active: true,
      settled: false,
      joiners: 0,
      settle,
      promise,
      cancelReason: undefined
    };
    this.flights.set(key, flight);
    this.liveFlights.add(flight);

    const operation = Promise.resolve().then(() => this.world.validate({
      ...request,
      fencingToken
    }));
    void operation.then((outcome) => {
      if (!flight.active || this.latestFence.get(scope) !== fencingToken || this.cancelledFences.has(`${scope}:${fencingToken}`) || outcome.fencingToken !== fencingToken) {
        this.#settle(flight, unknown(fencingToken, flight.cancelReason ?? "FENCED"));
        return;
      }
      this.#settle(flight, outcome);
    }, () => {
      this.#settle(flight, unknown(fencingToken, flight.cancelReason ?? "SOURCE_UNKNOWN"));
    }).finally(() => {
      this.liveFlights.delete(flight);
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });

    return promise;
  }

  #settle(flight, outcome) {
    if (flight.settled) return;
    flight.settled = true;
    flight.settle(outcome);
  }

  #cancel(flight, reason) {
    if (!flight.active) return false;
    flight.active = false;
    flight.cancelReason = reason;
    this.cancelledFences.add(`${flight.scope}:${flight.fencingToken}`);
    this.latestFence.set(flight.scope, ++this.nextFencingToken);
    this.#settle(flight, unknown(flight.fencingToken, reason));
    if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key);
    return true;
  }

  expire(request, reason = "LEASE_EXPIRED") {
    const normalized = this.#normalize(request);
    const flight = this.flights.get(requestKey(normalized));
    if (flight === undefined) return false;
    this.clock.advance(1);
    if (reason === "LEASE_EXPIRED") this.metrics.leaseExpiries += 1;
    if (reason === "TIMEOUT" || reason === "LEADER_CRASH") this.metrics.timeoutSignals += 1;
    return this.#cancel(flight, reason);
  }

  invalidate({ tenantId, resource, reason = "EVENT" }) {
    requiredString(tenantId, "tenantId");
    requiredString(resource, "resource");
    this.clock.advance(1);
    this.metrics.eventSignals += 1;
    for (const flight of [...this.liveFlights]) {
      if (flight.tenantId === tenantId && flight.resource === resource) this.#cancel(flight, reason);
    }
  }

  isFenceCurrent(request, fencingToken) {
    const normalized = this.#normalize(request);
    const scope = fenceScope(normalized);
    return this.latestFence.get(scope) === fencingToken && !this.cancelledFences.has(`${scope}:${fencingToken}`);
  }
}

class SideEffectGate {
  constructor(world, coordinator, clock, metrics) {
    this.world = world;
    this.coordinator = coordinator;
    this.clock = clock;
    this.metrics = metrics;
  }

  attempt({ request, outcome }) {
    this.metrics.sideEffectAttempts += 1;
    this.clock.advance(1);
    const current = this.world.snapshot(request.tenantId, request.resource);
    const fenceCurrent = this.coordinator.isFenceCurrent(request, outcome.fencingToken);
    const stale = current === undefined || !sameVersion(current.version, request.expectedVersion);
    let reason;
    if (!fenceCurrent) reason = "FENCE";
    else if (outcome.result === "UNKNOWN") reason = "UNKNOWN";
    else if (outcome.result !== "UNCHANGED") reason = "STALE";
    else if (stale) reason = "STALE";
    else if (!this.world.canAct(request)) reason = "AUTHORIZATION";

    if (reason === "FENCE") this.metrics.fenceRejectedAttempts += 1;
    if (reason !== undefined) {
      return { committed: false, reason };
    }

    if (stale) this.metrics.staleAccepted += 1;
    this.metrics.sideEffectCommits += 1;
    if (!fenceCurrent) this.metrics.oldFenceCommits += 1;
    if (current?.tenantId !== request.tenantId) this.metrics.crossTenantSideEffectCommits += 1;
    return { committed: true };
  }
}

function emptyMetrics() {
  return {
    physicalValidations: 0,
    joins: 0,
    crossTenantShares: 0,
    crossScopeShares: 0,
    staleOutcomes: 0,
    unknownOutcomes: 0,
    sideEffectAttempts: 0,
    sideEffectCommits: 0,
    staleAccepted: 0,
    oldFenceCommits: 0,
    crossTenantSideEffectCommits: 0,
    fenceRejectedAttempts: 0,
    eventSignals: 0,
    leaseExpiries: 0,
    timeoutSignals: 0,
    elapsedMs: 0,
    physicalValidationKeys: new Set()
  };
}

function metricSnapshot(metrics, clock) {
  const snapshot = {};
  for (const name of METRIC_NAMES) snapshot[name] = name === "elapsedMs" ? clock.now() : metrics[name];
  return snapshot;
}

function metricDelta(before, after) {
  const delta = {};
  for (const name of METRIC_NAMES) delta[name] = after[name] - before[name];
  return delta;
}

class Campaign {
  constructor(seed, workers) {
    this.seed = seed;
    this.workers = workers;
    this.clock = new VirtualClock();
    this.metrics = emptyMetrics();
    this.phases = [];
  }

  async phase(name, run) {
    const before = metricSnapshot(this.metrics, this.clock);
    const details = await run();
    const after = metricSnapshot(this.metrics, this.clock);
    this.phases.push({
      name,
      workers: this.workers,
      metrics: metricDelta(before, after),
      ...(details ?? {})
    });
  }

  recordOutcomes(outcomes) {
    const counts = { UNCHANGED: 0, CHANGED: 0, MISSING: 0, UNKNOWN: 0 };
    for (const outcome of outcomes) {
      counts[outcome.result] = (counts[outcome.result] ?? 0) + 1;
      if (outcome.result === "CHANGED") this.metrics.staleOutcomes += 1;
      if (outcome.result === "UNKNOWN") this.metrics.unknownOutcomes += 1;
    }
    return counts;
  }

  makeReport() {
    const metrics = metricSnapshot(this.metrics, this.clock);
    return {
      benchmark: "premise-next-coherence-storm",
      contract: "deterministic-in-memory-contract-smoke",
      seed: this.seed,
      workers: this.workers,
      phases: this.phases,
      metrics: {
        ...metrics,
        uniquePhysicalValidationKeys: this.metrics.physicalValidationKeys.size
      },
      safety: {
        noCrossTenantSharing: metrics.crossTenantShares === 0 && metrics.crossTenantSideEffectCommits === 0,
        noStaleAccepted: metrics.staleAccepted === 0,
        noOldFenceCommit: metrics.oldFenceCommits === 0,
        passed: metrics.crossTenantShares === 0
          && metrics.crossTenantSideEffectCommits === 0
          && metrics.staleAccepted === 0
          && metrics.oldFenceCommits === 0
      },
      limitations: {
        externalServices: false,
        distributedProof: false,
        wallClockMeasurement: false,
        virtualElapsedTime: true,
        processCrash: false
      }
    };
  }
}

function makeRequest(tenantId, resource, expectedVersion, authorizationScope = "scope:write") {
  return { tenantId, resource, expectedVersion: cloneVersion(expectedVersion), authorizationScope };
}

function makeFixture(seed, suffix) {
  return {
    tenantId: `tenant:${seed}:${suffix}`,
    resource: `source://premise-next/storm/${seed}/${suffix}`
  };
}

function assertPhaseMetric(phase, metric, expected, label) {
  if (phase.metrics[metric] !== expected) throw new Error(`${label}: expected ${metric}=${expected}, got ${phase.metrics[metric]}`);
}

async function exactCoalescing(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "exact");
  const world = new InMemoryWorld(campaign.clock, campaign.metrics);
  world.seed({ tenantId, resource });
  const coordinator = new StormCoordinator(world, campaign.clock, campaign.metrics);
  const actions = new SideEffectGate(world, coordinator, campaign.clock, campaign.metrics);
  const request = makeRequest(tenantId, resource, version("A", 1));
  const gate = world.blockNext(request);
  const promises = Array.from({ length: campaign.workers }, () => coordinator.validate(request));
  await flush();
  gate.resolve();
  const outcomes = await Promise.all(promises);
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  actions.attempt({ request, outcome: outcomes[0] });
  return { outcomeCounts, coalescing: "exact-key-only" };
}

async function authorizationScopes(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "scopes");
  const world = new InMemoryWorld(campaign.clock, campaign.metrics);
  world.seed({ tenantId, resource });
  const coordinator = new StormCoordinator(world, campaign.clock, campaign.metrics);
  const actions = new SideEffectGate(world, coordinator, campaign.clock, campaign.metrics);
  const readRequest = makeRequest(tenantId, resource, version("A", 1), "scope:read");
  const writeRequest = makeRequest(tenantId, resource, version("A", 1), "scope:write");
  const readGate = world.blockNext(readRequest);
  const writeGate = world.blockNext(writeRequest);
  const readPromises = Array.from({ length: campaign.workers / 2 }, () => coordinator.validate(readRequest));
  const writePromises = Array.from({ length: campaign.workers / 2 }, () => coordinator.validate(writeRequest));
  await flush();
  readGate.resolve();
  writeGate.resolve();
  const outcomes = [...await Promise.all(readPromises), ...await Promise.all(writePromises)];
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  actions.attempt({ request: readRequest, outcome: outcomes[0] });
  actions.attempt({ request: writeRequest, outcome: outcomes.at(-1) });
  return { outcomeCounts, authorizationScopes: ["scope:read", "scope:write"] };
}

async function tenants(campaign) {
  const resource = `source://premise-next/storm/${campaign.seed}/same-resource`;
  const world = new InMemoryWorld(campaign.clock, campaign.metrics);
  const coordinator = new StormCoordinator(world, campaign.clock, campaign.metrics);
  const actions = new SideEffectGate(world, coordinator, campaign.clock, campaign.metrics);
  const requests = [];
  for (let index = 0; index < campaign.workers; index += 1) {
    const tenantId = `tenant:${campaign.seed}:isolated:${index}`;
    world.seed({ tenantId, resource });
    requests.push(makeRequest(tenantId, resource, version("A", 1)));
  }
  const outcomes = await Promise.all(requests.map((request) => coordinator.validate(request)));
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  for (let index = 0; index < outcomes.length; index += 1) actions.attempt({ request: requests[index], outcome: outcomes[index] });
  return { outcomeCounts, sameResource: true, tenantCount: campaign.workers };
}

async function leaseExpiry(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "lease");
  const world = new InMemoryWorld(campaign.clock, campaign.metrics);
  world.seed({ tenantId, resource });
  const coordinator = new StormCoordinator(world, campaign.clock, campaign.metrics);
  const actions = new SideEffectGate(world, coordinator, campaign.clock, campaign.metrics);
  const request = makeRequest(tenantId, resource, version("A", 1));
  const oldGate = world.blockNext(request, (input) => input.fencingToken === 1);
  const oldPromise = coordinator.validate(request);
  await flush();
  coordinator.expire(request, "LEASE_EXPIRED");
  const expired = await oldPromise;
  const replacementPromise = coordinator.validate(request);
  const replacement = await replacementPromise;
  oldGate.resolve();
  await flush();
  const outcomeCounts = campaign.recordOutcomes([expired, replacement]);
  actions.attempt({ request, outcome: expired });
  actions.attempt({ request, outcome: replacement });
  return { outcomeCounts, replacementFence: replacement.fencingToken, expiredReason: expired.reason };
}

async function leaderTimeout(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "timeout");
  const world = new InMemoryWorld(campaign.clock, campaign.metrics);
  world.seed({ tenantId, resource });
  const coordinator = new StormCoordinator(world, campaign.clock, campaign.metrics);
  const actions = new SideEffectGate(world, coordinator, campaign.clock, campaign.metrics);
  const request = makeRequest(tenantId, resource, version("A", 1));
  const gate = world.blockNext(request, (input) => input.fencingToken === 1);
  const promises = Array.from({ length: campaign.workers }, () => coordinator.validate(request));
  await flush();
  coordinator.expire(request, "TIMEOUT");
  const outcomes = await Promise.all(promises);
  gate.resolve();
  await flush();
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  actions.attempt({ request, outcome: outcomes[0] });
  return { outcomeCounts, leader: "timed-out", followers: campaign.workers - 1 };
}

async function mutationDuringValidation(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "mutation");
  const world = new InMemoryWorld(campaign.clock, campaign.metrics);
  world.seed({ tenantId, resource });
  const coordinator = new StormCoordinator(world, campaign.clock, campaign.metrics);
  const actions = new SideEffectGate(world, coordinator, campaign.clock, campaign.metrics);
  const request = makeRequest(tenantId, resource, version("A", 1));
  const gate = world.blockNext(request);
  const promises = Array.from({ length: campaign.workers }, () => coordinator.validate(request));
  await flush();
  world.mutate({ tenantId, resource, label: "B" });
  gate.resolve();
  const outcomes = await Promise.all(promises);
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  for (const outcome of outcomes) actions.attempt({ request, outcome });
  return { outcomeCounts, mutation: "A-to-B-during-validation" };
}

async function eventDuringFlight(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "event");
  const world = new InMemoryWorld(campaign.clock, campaign.metrics);
  world.seed({ tenantId, resource });
  const coordinator = new StormCoordinator(world, campaign.clock, campaign.metrics);
  const actions = new SideEffectGate(world, coordinator, campaign.clock, campaign.metrics);
  const request = makeRequest(tenantId, resource, version("A", 1));
  const gate = world.blockNext(request);
  const promises = Array.from({ length: campaign.workers }, () => coordinator.validate(request));
  await flush();
  world.mutate({ tenantId, resource, label: "B" });
  coordinator.invalidate({ tenantId, resource, reason: "EVENT" });
  gate.resolve();
  const outcomes = await Promise.all(promises);
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  for (const outcome of outcomes) actions.attempt({ request, outcome });
  return { outcomeCounts, invalidation: "event-during-flight" };
}

async function fencingAndAba(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "aba");
  const world = new InMemoryWorld(campaign.clock, campaign.metrics);
  world.seed({ tenantId, resource });
  const coordinator = new StormCoordinator(world, campaign.clock, campaign.metrics);
  const actions = new SideEffectGate(world, coordinator, campaign.clock, campaign.metrics);
  const firstA = makeRequest(tenantId, resource, version("A", 1));
  const b = makeRequest(tenantId, resource, version("B", 2));
  const secondA = makeRequest(tenantId, resource, version("A", 3));
  const oldAGate = world.blockNext(firstA);
  const bGate = world.blockNext(b);
  const secondAGate = world.blockNext(secondA);

  const firstPromises = Array.from({ length: 40 }, () => coordinator.validate(firstA));
  await flush();
  world.mutate({ tenantId, resource, label: "B" });
  const bPromises = Array.from({ length: 30 }, () => coordinator.validate(b));
  await flush();
  world.mutate({ tenantId, resource, label: "A" });
  const secondPromises = Array.from({ length: 30 }, () => coordinator.validate(secondA));
  await flush();

  bGate.resolve();
  secondAGate.resolve();
  oldAGate.resolve();
  const outcomes = [...await Promise.all(firstPromises), ...await Promise.all(bPromises), ...await Promise.all(secondPromises)];
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  for (let index = 0; index < 40; index += 1) actions.attempt({ request: firstA, outcome: outcomes[index] });
  for (let index = 40; index < 70; index += 1) actions.attempt({ request: b, outcome: outcomes[index] });
  for (let index = 70; index < 100; index += 1) actions.attempt({ request: secondA, outcome: outcomes[index] });
  return {
    outcomeCounts,
    sequence: ["A@1", "B@2", "A@3"],
    oldFence: outcomes[0].fencingToken,
    finalFence: outcomes.at(-1).fencingToken
  };
}

function assertSafety(report) {
  if (!report.safety.noCrossTenantSharing) throw new Error("coherence storm safety failure: cross-tenant share detected");
  if (!report.safety.noStaleAccepted) throw new Error("coherence storm safety failure: stale side effect accepted");
  if (!report.safety.noOldFenceCommit) throw new Error("coherence storm safety failure: old fencing token committed");
  if (!report.safety.passed) throw new Error("coherence storm safety failure");
}

export async function runCoherenceStorm(options = {}) {
  const workers = options.workers ?? WORKER_COUNT;
  if (workers !== WORKER_COUNT) throw new RangeError(`this contract smoke requires exactly ${WORKER_COUNT} workers`);
  const seed = options.seed ?? DEFAULT_SEED;
  requiredString(seed, "seed");
  const campaign = new Campaign(seed, workers);
  await campaign.phase("exact-coalescing", () => exactCoalescing(campaign));
  await campaign.phase("authorization-scopes", () => authorizationScopes(campaign));
  await campaign.phase("100-tenants-same-resource", () => tenants(campaign));
  await campaign.phase("lease-expiry", () => leaseExpiry(campaign));
  await campaign.phase("leader-timeout", () => leaderTimeout(campaign));
  await campaign.phase("source-mutation-during-validation", () => mutationDuringValidation(campaign));
  await campaign.phase("event-during-flight", () => eventDuringFlight(campaign));
  await campaign.phase("old-fence-and-aba", () => fencingAndAba(campaign));
  const report = campaign.makeReport();
  assertSafety(report);
  return report;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const seedArgument = process.argv.find((argument) => argument.startsWith("--seed="));
  const seed = seedArgument === undefined ? DEFAULT_SEED : seedArgument.slice("--seed=".length);
  const report = await runCoherenceStorm({ seed });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
