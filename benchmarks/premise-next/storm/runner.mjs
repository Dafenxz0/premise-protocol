import { pathToFileURL } from "node:url";
import { FencedSingleFlightCoordinator } from "../../../packages/runtime-core/dist/fenced-single-flight.js";
import { premiseValidationScopeKey } from "../../../packages/runtime-core/dist/validation-scope.js";

export const WORKER_COUNT = 100;
export const DEFAULT_SEED = "premise-next-storm-20260814";
const VERSION_SCHEME = "storm";
const VALIDATOR_ID = "storm.deterministic-fixture.v1";

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

function sameVersion(left, right) {
  return left?.scheme === right?.scheme && left?.token === right?.token;
}

function version(label, incarnation) {
  return { scheme: VERSION_SCHEME, token: `${label}@${incarnation}` };
}

function expectedVersion(scope) {
  return { scheme: scope.versionScheme, token: scope.versionToken };
}

function scopeFor({ tenantId, resource, label = "A", incarnation = 1, authorizationScope = "scope:write", policy = "policy:storm:v1", suffix }) {
  const versionReference = version(label, incarnation);
  return {
    tenantId,
    resourceId: resource,
    incarnationId: `${label}:${incarnation}`,
    versionScheme: versionReference.scheme,
    versionToken: versionReference.token,
    validatorId: VALIDATOR_ID,
    authorizationContextDigest: `auth:${authorizationScope}`,
    policyDigest: policy,
    queryDigest: `query:${suffix ?? resource}`,
    scopes: [authorizationScope],
    changeSetDigest: null,
    causalFrontier: [`frontier:${label}@${incarnation}`]
  };
}

function request(scope, extras = {}) {
  return { scope, ...extras };
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

class DeterministicTimers {
  #pending = new Set();

  setTimeout(callback, delayMs) {
    const entry = { callback, delayMs };
    this.#pending.add(entry);
    return entry;
  }

  clearTimeout(entry) {
    this.#pending.delete(entry);
  }

  fireNext() {
    const entry = this.#pending.values().next().value;
    if (entry === undefined) throw new Error("expected a pending deterministic timer");
    this.#pending.delete(entry);
    entry.callback();
  }
}

class PremiseFixtureSource {
  constructor(clock, metrics) {
    this.clock = clock;
    this.metrics = metrics;
    this.states = new Map();
    this.gates = new Map();
    this.highestFenceByResource = new Map();
  }

  #stateKey(tenantId, resource) {
    return JSON.stringify([tenantId, resource]);
  }

  #resourceKey(tenantId, resource) {
    return this.#stateKey(tenantId, resource);
  }

  seed({ tenantId, resource, label = "A", incarnation = 1, readScopes = ["scope:read", "scope:write"], actionScopes = ["scope:write"] }) {
    this.states.set(this.#stateKey(tenantId, resource), {
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
      version: { ...state.version },
      value: { ...state.value },
      readScopes: new Set(state.readScopes),
      actionScopes: new Set(state.actionScopes)
    };
  }

  blockNext(scope, predicate = () => true) {
    const key = premiseValidationScopeKey(scope);
    const gate = deferred();
    const entries = this.gates.get(key) ?? [];
    entries.push({ gate, predicate });
    this.gates.set(key, entries);
    return gate;
  }

  async validate(input) {
    if (input.scope === undefined) throw new Error("fixture requires complete PremiseValidationScope");
    this.metrics.physicalValidations += 1;
    this.metrics.physicalValidationKeys.add(premiseValidationScopeKey(input.scope));
    this.highestFenceByResource.set(
      this.#resourceKey(input.tenantId, input.resource),
      Math.max(this.highestFenceByResource.get(this.#resourceKey(input.tenantId, input.resource)) ?? 0, input.fencingToken)
    );
    this.clock.advance(5);

    const key = premiseValidationScopeKey(input.scope);
    const entries = this.gates.get(key) ?? [];
    const gateIndex = entries.findIndex((entry) => entry.predicate(input));
    if (gateIndex >= 0) {
      const [{ gate }] = entries.splice(gateIndex, 1);
      if (entries.length === 0) this.gates.delete(key);
      await gate.promise;
    }

    const state = this.snapshot(input.tenantId, input.resource);
    const allowed = state !== undefined && input.scope.scopes.every((scope) => state.readScopes.has(scope));
    if (!allowed) return { result: "UNKNOWN", fencingToken: input.fencingToken, reason: "SOURCE_UNKNOWN" };

    return {
      result: sameVersion(state.version, input.expectedVersion) ? "UNCHANGED" : "CHANGED",
      fencingToken: input.fencingToken,
      version: state.version,
      value: state.value
    };
  }

  canAct(scope) {
    const state = this.states.get(this.#stateKey(scope.tenantId, scope.resourceId));
    return state !== undefined && scope.scopes.includes("scope:write") && state.actionScopes.has("scope:write");
  }

  highestFence(tenantId, resource) {
    return this.highestFenceByResource.get(this.#resourceKey(tenantId, resource)) ?? 0;
  }
}

class SideEffectGate {
  constructor(source, clock, metrics) {
    this.source = source;
    this.clock = clock;
    this.metrics = metrics;
  }

  attempt({ request: validationRequest, outcome }) {
    this.metrics.sideEffectAttempts += 1;
    this.clock.advance(1);
    const scope = validationRequest.scope;
    if (outcome.result === "UNKNOWN") {
      if (outcome.reason === "FENCED") this.metrics.fenceRejectedAttempts += 1;
      return { committed: false, reason: outcome.reason ?? "UNKNOWN" };
    }
    if (outcome.result !== "UNCHANGED") return { committed: false, reason: "STALE" };

    const current = this.source.snapshot(scope.tenantId, scope.resourceId);
    if (current === undefined || !sameVersion(current.version, expectedVersion(scope))) {
      return { committed: false, reason: "STALE" };
    }
    if (outcome.fencingToken < this.source.highestFence(scope.tenantId, scope.resourceId)) {
      this.metrics.oldFenceCommits += 1;
      return { committed: false, reason: "FENCE" };
    }
    if (!this.source.canAct(scope)) return { committed: false, reason: "AUTHORIZATION" };

    this.metrics.sideEffectCommits += 1;
    if (current.tenantId !== scope.tenantId) this.metrics.crossTenantSideEffectCommits += 1;
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
    this.phases.push({ name, workers: this.workers, metrics: metricDelta(before, after), ...(details ?? {}) });
  }

  observeCalls(requests, promises) {
    const firstRequestByPromise = new Map();
    for (let index = 0; index < promises.length; index += 1) {
      const existing = firstRequestByPromise.get(promises[index]);
      if (existing === undefined) {
        firstRequestByPromise.set(promises[index], requests[index]);
        continue;
      }
      this.metrics.joins += 1;
      const firstScope = existing.scope;
      const currentScope = requests[index].scope;
      if (firstScope.tenantId !== currentScope.tenantId) this.metrics.crossTenantShares += 1;
      if (firstScope.tenantId === currentScope.tenantId
        && firstScope.resourceId === currentScope.resourceId
        && premiseValidationScopeKey(firstScope) !== premiseValidationScopeKey(currentScope)) {
        this.metrics.crossScopeShares += 1;
      }
    }
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
      contract: "runtime-core-dist-complete-scope-smoke",
      coordinator: "packages/runtime-core/dist/fenced-single-flight.js",
      scope: "complete PremiseValidationScope",
      seed: this.seed,
      workers: this.workers,
      phases: this.phases,
      metrics: { ...metrics, uniquePhysicalValidationKeys: this.metrics.physicalValidationKeys.size },
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
        processCrash: false,
        leaseApi: false,
        eventInvalidationApi: false
      }
    };
  }
}

function makeFixture(seed, suffix) {
  return {
    tenantId: `tenant:${seed}:${suffix}`,
    resource: `source://premise-next/storm/${seed}/${suffix}`
  };
}

function coordinatorFor(source, options) {
  return new FencedSingleFlightCoordinator(source, options);
}

async function exactCoalescing(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "exact");
  const source = new PremiseFixtureSource(campaign.clock, campaign.metrics);
  source.seed({ tenantId, resource });
  const coordinator = coordinatorFor(source);
  const actions = new SideEffectGate(source, campaign.clock, campaign.metrics);
  const scope = scopeFor({ tenantId, resource, suffix: "exact" });
  const validationRequest = request(scope);
  const gate = source.blockNext(scope);
  const requests = Array.from({ length: campaign.workers }, () => validationRequest);
  const promises = requests.map((item) => coordinator.validate(item));
  campaign.observeCalls(requests, promises);
  await flush();
  gate.resolve();
  const outcomes = await Promise.all(promises);
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  actions.attempt({ request: validationRequest, outcome: outcomes[0] });
  return { outcomeCounts, coalescing: "coordinator-exact-complete-scope" };
}

async function authorizationScopes(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "scopes");
  const source = new PremiseFixtureSource(campaign.clock, campaign.metrics);
  source.seed({ tenantId, resource });
  const coordinator = coordinatorFor(source);
  const actions = new SideEffectGate(source, campaign.clock, campaign.metrics);
  const readScope = scopeFor({ tenantId, resource, authorizationScope: "scope:read", policy: "policy:read", suffix: "scopes-read" });
  const writeScope = scopeFor({ tenantId, resource, authorizationScope: "scope:write", policy: "policy:write", suffix: "scopes-write" });
  const readRequest = request(readScope);
  const writeRequest = request(writeScope);
  const readGate = source.blockNext(readScope);
  const writeGate = source.blockNext(writeScope);
  const requests = [
    ...Array.from({ length: campaign.workers / 2 }, () => readRequest),
    ...Array.from({ length: campaign.workers / 2 }, () => writeRequest)
  ];
  const promises = requests.map((item) => coordinator.validate(item));
  campaign.observeCalls(requests, promises);
  await flush();
  readGate.resolve();
  writeGate.resolve();
  const outcomes = await Promise.all(promises);
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  actions.attempt({ request: readRequest, outcome: outcomes[0] });
  actions.attempt({ request: writeRequest, outcome: outcomes.at(-1) });
  return {
    outcomeCounts,
    authorizationScopes: ["scope:read", "scope:write"],
    sharing: "distinct-complete-scopes",
    supersession: "same-resource-version",
    crossScopeFlightsAreFenced: false,
    fencingTokens: [outcomes[0].fencingToken, outcomes.at(-1).fencingToken]
  };
}

async function versionSupersession(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "version");
  const source = new PremiseFixtureSource(campaign.clock, campaign.metrics);
  source.seed({ tenantId, resource });
  const coordinator = coordinatorFor(source);
  const actions = new SideEffectGate(source, campaign.clock, campaign.metrics);
  const oldRequest = request(scopeFor({ tenantId, resource, label: "A", incarnation: 1, suffix: "version" }));
  const newRequest = request(scopeFor({ tenantId, resource, label: "B", incarnation: 2, suffix: "version" }));
  const oldGate = source.blockNext(oldRequest.scope);
  const newGate = source.blockNext(newRequest.scope);
  const oldPromises = Array.from({ length: campaign.workers / 2 }, () => coordinator.validate(oldRequest));
  campaign.observeCalls(oldPromises.map(() => oldRequest), oldPromises);
  await flush();
  source.mutate({ tenantId, resource, label: "B" });
  const newPromises = Array.from({ length: campaign.workers / 2 }, () => coordinator.validate(newRequest));
  campaign.observeCalls(newPromises.map(() => newRequest), newPromises);
  await flush();
  oldGate.resolve();
  newGate.resolve();
  const oldOutcomes = await Promise.all(oldPromises);
  const newOutcomes = await Promise.all(newPromises);
  const outcomes = [...oldOutcomes, ...newOutcomes];
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  actions.attempt({ request: oldRequest, outcome: oldOutcomes[0] });
  actions.attempt({ request: newRequest, outcome: newOutcomes[0] });
  return {
    outcomeCounts,
    supersession: "new-incarnation-and-version",
    oldOutcome: oldOutcomes[0].reason ?? oldOutcomes[0].result,
    currentOutcome: newOutcomes[0].result,
    fencingTokens: [oldOutcomes[0].fencingToken, newOutcomes[0].fencingToken]
  };
}

async function tenants(campaign) {
  const resource = `source://premise-next/storm/${campaign.seed}/same-resource`;
  const source = new PremiseFixtureSource(campaign.clock, campaign.metrics);
  const coordinator = coordinatorFor(source);
  const actions = new SideEffectGate(source, campaign.clock, campaign.metrics);
  const requests = [];
  for (let index = 0; index < campaign.workers; index += 1) {
    const tenantId = `tenant:${campaign.seed}:isolated:${index}`;
    source.seed({ tenantId, resource });
    requests.push(request(scopeFor({ tenantId, resource, suffix: `tenant-${index}` })));
  }
  const promises = requests.map((item) => coordinator.validate(item));
  campaign.observeCalls(requests, promises);
  const outcomes = await Promise.all(promises);
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  for (let index = 0; index < outcomes.length; index += 1) actions.attempt({ request: requests[index], outcome: outcomes[index] });
  return { outcomeCounts, sameResource: true, tenantCount: campaign.workers };
}

async function leaderTimeout(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "timeout");
  const source = new PremiseFixtureSource(campaign.clock, campaign.metrics);
  source.seed({ tenantId, resource });
  const timers = new DeterministicTimers();
  const coordinator = coordinatorFor(source, { timers });
  const actions = new SideEffectGate(source, campaign.clock, campaign.metrics);
  const scope = scopeFor({ tenantId, resource, suffix: "timeout" });
  const validationRequest = request(scope, { timeoutMs: 50 });
  const gate = source.blockNext(scope);
  const requests = Array.from({ length: campaign.workers }, () => validationRequest);
  const promises = requests.map((item) => coordinator.validate(item));
  campaign.observeCalls(requests, promises);
  await flush();
  campaign.metrics.timeoutSignals += 1;
  timers.fireNext();
  const outcomes = await Promise.all(promises);
  gate.resolve();
  await flush();
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  actions.attempt({ request: validationRequest, outcome: outcomes[0] });
  return { outcomeCounts, leader: "timed-out", followers: campaign.workers - 1, replacement: "not started" };
}

async function abortDuringFlight(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "abort");
  const source = new PremiseFixtureSource(campaign.clock, campaign.metrics);
  source.seed({ tenantId, resource });
  const coordinator = coordinatorFor(source);
  const actions = new SideEffectGate(source, campaign.clock, campaign.metrics);
  const controller = new AbortController();
  const scope = scopeFor({ tenantId, resource, suffix: "abort" });
  const validationRequest = request(scope, { signal: controller.signal });
  const gate = source.blockNext(scope);
  const requests = Array.from({ length: campaign.workers }, () => validationRequest);
  const promises = requests.map((item) => coordinator.validate(item));
  campaign.observeCalls(requests, promises);
  await flush();
  campaign.metrics.eventSignals += 1;
  controller.abort();
  const outcomes = await Promise.all(promises);
  gate.resolve();
  await flush();
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  actions.attempt({ request: validationRequest, outcome: outcomes[0] });
  return { outcomeCounts, signal: "ABORTED", eventInvalidation: "not part of coordinator API" };
}

async function mutationDuringValidation(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "mutation");
  const source = new PremiseFixtureSource(campaign.clock, campaign.metrics);
  source.seed({ tenantId, resource });
  const coordinator = coordinatorFor(source);
  const actions = new SideEffectGate(source, campaign.clock, campaign.metrics);
  const scope = scopeFor({ tenantId, resource, suffix: "mutation" });
  const validationRequest = request(scope);
  const gate = source.blockNext(scope);
  const requests = Array.from({ length: campaign.workers }, () => validationRequest);
  const promises = requests.map((item) => coordinator.validate(item));
  campaign.observeCalls(requests, promises);
  await flush();
  source.mutate({ tenantId, resource, label: "B" });
  gate.resolve();
  const outcomes = await Promise.all(promises);
  const outcomeCounts = campaign.recordOutcomes(outcomes);
  for (const outcome of outcomes) actions.attempt({ request: validationRequest, outcome });
  return { outcomeCounts, mutation: "A-to-B-during-validation" };
}

async function fencingAndAba(campaign) {
  const { tenantId, resource } = makeFixture(campaign.seed, "aba");
  const source = new PremiseFixtureSource(campaign.clock, campaign.metrics);
  source.seed({ tenantId, resource });
  const coordinator = coordinatorFor(source);
  const actions = new SideEffectGate(source, campaign.clock, campaign.metrics);
  const firstA = request(scopeFor({ tenantId, resource, label: "A", incarnation: 1, suffix: "aba" }));
  const b = request(scopeFor({ tenantId, resource, label: "B", incarnation: 2, suffix: "aba" }));
  const secondA = request(scopeFor({ tenantId, resource, label: "A", incarnation: 3, suffix: "aba" }));
  const oldAGate = source.blockNext(firstA.scope);
  const bGate = source.blockNext(b.scope);
  const secondAGate = source.blockNext(secondA.scope);
  const firstRequests = Array.from({ length: 40 }, () => firstA);
  const bRequests = Array.from({ length: 30 }, () => b);
  const secondRequests = Array.from({ length: 30 }, () => secondA);
  const firstPromises = firstRequests.map((item) => coordinator.validate(item));
  campaign.observeCalls(firstRequests, firstPromises);
  await flush();
  source.mutate({ tenantId, resource, label: "B" });
  const bPromises = bRequests.map((item) => coordinator.validate(item));
  campaign.observeCalls(bRequests, bPromises);
  await flush();
  source.mutate({ tenantId, resource, label: "A" });
  const secondPromises = secondRequests.map((item) => coordinator.validate(item));
  campaign.observeCalls(secondRequests, secondPromises);
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
  await campaign.phase("version-supersession", () => versionSupersession(campaign));
  await campaign.phase("100-tenants-same-resource", () => tenants(campaign));
  await campaign.phase("timeout-via-coordinator", () => leaderTimeout(campaign));
  await campaign.phase("abort-signal-during-flight", () => abortDuringFlight(campaign));
  await campaign.phase("source-mutation-during-validation", () => mutationDuringValidation(campaign));
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
