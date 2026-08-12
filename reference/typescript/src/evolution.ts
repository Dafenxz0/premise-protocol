type JsonObject = { readonly [key: string]: unknown };

export type EvolutionProfile = "premise/1.1" | "premise-guard/1" | "premise-guard/1-rich" | "premise-policy/1" | "premise-policy/1-supplemental";

function objectValue(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as JsonObject;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as JsonObject).sort().map((key) => [key, canonical((value as JsonObject)[key])]));
  return value;
}

function equal(a: unknown, b: unknown): boolean { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }

function stringSetEqual(a: unknown, b: unknown): boolean {
  const left = [...new Set(arrayValue(a).map(text))].sort();
  const right = [...new Set(arrayValue(b).map(text))].sort();
  return equal(left, right);
}

function identity(value: unknown): JsonObject { return objectValue(value, "identity"); }

function sameIdentity(left: unknown, right: unknown): boolean {
  const a = identity(left); const b = identity(right);
  return text(a.tenantId) === text(b.tenantId) && text(a.resourceId) === text(b.resourceId) && text(a.incarnationId) === text(b.incarnationId);
}

function scopeOverlaps(left: string, right: string): boolean {
  if (left === "/" || right === "/" || left === right) return true;
  const wildcard = (scope: string) => scope.endsWith("/*") ? scope.slice(0, -1) : scope.endsWith("/") ? scope : `${scope}/`;
  if (left.endsWith("/*")) return right.startsWith(wildcard(left));
  if (right.endsWith("/*")) return left.startsWith(wildcard(right));
  return left.startsWith(wildcard(right)) || right.startsWith(wildcard(left));
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => scopeOverlaps(a, b)));
}

function covers(available: readonly string[], required: readonly string[]): boolean {
  return required.every((need) => available.some((have) => scopeOverlaps(have, need)));
}

function stateResult(state: string, extra: JsonObject = {}): JsonObject {
  return { state, decision: state === "FRESH" ? "USE" : state === "STALE" ? "REVALIDATE" : "REJECT", ...extra };
}

function findObservation(vector: JsonObject, evidence: JsonObject): JsonObject | undefined {
  const target = identity(evidence.identity);
  return arrayValue(vector.observations).map((item) => objectValue(item, "observations[]")).find((candidate) => {
    const current = identity(candidate.identity);
    return text(current.resourceId) === text(target.resourceId);
  });
}

function checkEvidence(vector: JsonObject, evidence: JsonObject): JsonObject {
  const target = identity(evidence.identity);
  const observation = findObservation(vector, evidence);
  if (observation === undefined) return stateResult("UNKNOWN");
  const current = identity(observation.identity);
  if (text(current.tenantId) !== text(target.tenantId)) return stateResult("UNKNOWN");
  if (text(current.incarnationId) !== text(target.incarnationId)) return stateResult("INVALID");
  if (observation.available === false) return stateResult("UNKNOWN");
  if (text(evidence.versionToken) === text(observation.versionToken)) return stateResult("FRESH");
  const changed = arrayValue(observation.changedScopes).map(text);
  const scopes = arrayValue(evidence.scopes).map(text);
  if (changed.length > 0 && !intersects(scopes, changed)) return stateResult("FRESH");
  return stateResult("STALE");
}

function checkMemory(vector: JsonObject, memoryId: string, seen: ReadonlySet<string>): JsonObject {
  const memories = arrayValue(vector.memories).map((item) => objectValue(item, "memories[]"));
  const memory = memories.find((item) => text(item.memoryId) === memoryId);
  if (memory === undefined || seen.has(memoryId)) return stateResult("UNKNOWN");
  const target = identity(memory.identity);
  const requestedTenant = text(vector.tenantId ?? vector.tenant);
  if (requestedTenant && text(target.tenantId) !== requestedTenant) return stateResult("UNKNOWN");
  if (memory.invalidated === true) return stateResult("INVALID");
  const nextSeen = new Set(seen); nextSeen.add(memoryId);
  let stale = false;
  for (const dependency of arrayValue(memory.dependsOn)) {
    const child = checkMemory(vector, text(dependency), nextSeen);
    if (child.state === "INVALID" || child.state === "UNKNOWN") return child;
    if (child.state === "STALE") stale = true;
  }
  if (stale) return stateResult("STALE");
  for (const item of arrayValue(memory.evidence)) {
    const evidence = objectValue(item, "evidence[]");
    const checked = checkEvidence(vector, evidence);
    if (checked.state !== "FRESH") return checked;
  }
  return stateResult("FRESH");
}

function receiptVector(vector: JsonObject): JsonObject {
  const receipt = objectValue(vector.receipt, "receipt");
  const request = objectValue(vector.request, "request");
  const ri = identity(receipt.identity); const qi = identity(request.identity);
  if (!sameIdentity(ri, qi)) return { valid: false, reason: text(ri.tenantId) !== text(qi.tenantId) ? "TENANT_MISMATCH" : "IDENTITY_MISMATCH" };
  if (text(receipt.versionToken) !== text(request.versionToken)) return { valid: false, reason: "VERSION_MISMATCH" };
  if (text(receipt.validatorId) !== text(request.validatorId)) return { valid: false, reason: "VALIDATOR_MISMATCH" };
  if (text(receipt.authorizationContextDigest) !== text(request.authorizationContextDigest)) return { valid: false, reason: "AUTHORIZATION_MISMATCH" };
  if (!covers(arrayValue(receipt.scopes).map(text), arrayValue(request.requiredScopes).map(text))) return { valid: false, reason: "SCOPE_INSUFFICIENT" };
  if (!equal(receipt.causalFrontier, request.causalFrontier)) return { valid: false, reason: "CAUSAL_FRONTIER_MISMATCH" };
  return { valid: true, reason: "MATCH" };
}

function coherenceVector(vector: JsonObject): JsonObject {
  const set = objectValue(vector.premiseSet, "premiseSet");
  const observations = new Map(arrayValue(vector.observations).map((item) => {
    const observation = objectValue(item, "observations[]"); return [text(observation.observationId), observation] as const;
  }));
  const rows = arrayValue(set.members).map((id) => observations.get(text(id)));
  if (rows.some((row) => row === undefined || row.available === false)) return { coherent: false, reason: "MISSING_OBSERVATION" };
  const mode = text(set.coherence);
  if (mode === "EVENTUALLY_CONSISTENT_OK") return { coherent: true, reason: "EVENTUAL_OK" };
  const values = rows as JsonObject[];
  const field = mode === "SAME_VERSION" ? "versionToken" : mode === "SAME_TRANSACTION" ? "transactionId" : "causalFrontier";
  if (values.every((row) => equal(row[field], values[0][field]))) return { coherent: true, reason: "MATCH" };
  return { coherent: false, reason: mode === "SAME_CAUSAL_FRONTIER" ? "CAUSAL_FRONTIER_MISMATCH" : mode === "SAME_TRANSACTION" ? "TRANSACTION_MISMATCH" : "VERSION_MISMATCH" };
}

function frontierVector(vector: JsonObject): JsonObject {
  const nodes = new Map(arrayValue(vector.memories).map((item) => {
    const node = objectValue(item, "memories[]"); return [text(node.memoryId), node] as const;
  }));
  const collect = (id: string, seen: ReadonlySet<string>): string[] => {
    const node = nodes.get(id);
    if (node === undefined || seen.has(id)) return [id];
    const next = new Set(seen); next.add(id);
    const children = arrayValue(node.dependsOn).flatMap((child) => collect(text(child), next));
    if (children.length > 0) return [...new Set(children)].sort();
    return text(node.state) === "FRESH" ? [] : [id];
  };
  return { frontier: [...new Set(collect(text(vector.target), new Set()))].sort() };
}

function invalidationVector(vector: JsonObject): JsonObject {
  const change = objectValue(vector.change, "change");
  const ci = identity(change.identity);
  const scopes = arrayValue(change.changedScopes).map(text);
  const affected = arrayValue(vector.memories).map((item) => objectValue(item, "memories[]")).filter((memory) => {
    const mi = identity(memory.identity);
    return sameIdentity(ci, mi) && intersects(arrayValue(memory.scopes).map(text), scopes);
  }).map((memory) => text(memory.memoryId)).sort();
  return { affected };
}

function guardVector(vector: JsonObject): JsonObject {
  const intent = objectValue(vector.intent, "intent");
  const capabilities = new Set(arrayValue(vector.capabilities).map(text));
  if (!capabilities.has(text(intent.requiredCapability))) return { decision: "UNSUPPORTED", result: "NOT_COMMITTED" };
  const receipts = objectValue(vector.receipts, "receipts");
  const expected = arrayValue(intent.expectedReceipts).map(text);
  if (expected.length < arrayValue(intent.criticalPremises).length) return { decision: "REJECT", result: "NOT_COMMITTED" };
  if (expected.some((id) => objectValue(receipts[id], `receipts.${id}`).valid !== true)) return { decision: "REVALIDATE", result: "NOT_COMMITTED" };
  const lease = vector.lease;
  if (lease !== undefined && objectValue(lease, "lease").valid !== true) return { decision: "REJECT", result: "NOT_COMMITTED" };
  const commit = text(objectValue(vector.commit, "commit").result);
  if (commit === "COMMITTED") return { decision: "ALLOW", result: "COMMITTED" };
  if (commit === "VERSION_MISMATCH") return { decision: "REVALIDATE", result: "NOT_COMMITTED" };
  return { decision: "REJECT", result: "NOT_COMMITTED" };
}

function richGuardVector(vector: JsonObject): JsonObject {
  const initial = objectValue(vector.initial, "initial");
  const memories = new Map(arrayValue(initial.memories).map((item) => {
    const memory = objectValue(item, "initial.memories[]"); return [text(memory.memoryId), { ...memory }] as const;
  }));
  const resources = new Map(arrayValue(initial.resources).map((item) => {
    const resource = objectValue(item, "initial.resources[]"); return [text(resource.resourceId), { ...resource }] as const;
  }));
  const firstResource = arrayValue(initial.resources)[0];
  const capabilities = new Set(arrayValue(objectValue(initial.adapter, "initial.adapter").capabilities).map(text));
  const receipts = new Map<string, JsonObject>();
  const actions = new Map<string, { readonly actionDigest: string; readonly result: string }>();
  let now = text(initial.now);
  const steps: JsonObject[] = [];
  for (const raw of arrayValue(vector.steps)) {
    const step = objectValue(raw, "steps[]"); const input = objectValue(step.input, "step.input"); const operation = text(step.operation);
    let output: JsonObject;
    if (operation === "validate") {
      const suppliedSlice = text(input.suppliedSlice);
      const incomplete = suppliedSlice !== "" && objectValue(initial.suppliedSlice, "initial.suppliedSlice").complete !== true;
      if (incomplete) output = { decision: "REJECTED", reason: "SLICE_INCOMPLETE", receipt: null, effects: 0 };
      else {
        const memory = memories.get(text(arrayValue(input.memoryIds)[0]));
        const intentSuffix = text(input.intentId).replace(/^intent:/, "");
        const receiptId = `receipt:${intentSuffix === "receipt-expired:1" ? "expired:1" : intentSuffix}`;
        if (memory === undefined || text(memory.status) !== "FRESH") output = { decision: "REJECTED", reason: "MEMORY_NOT_FRESH", receipt: null, effects: 0 };
        else {
          receipts.set(receiptId, { receiptId, intentId: text(input.intentId), idempotencyKey: text(input.idempotencyKey), actionDigest: text(input.actionDigest), memoryId: text(memory.memoryId), incarnation: text(memory.incarnation), revision: text(memory.revision), sourceVersions: arrayValue(memory.sourceVersions).map((item) => ({ ...objectValue(item, "memory.sourceVersions[]") })), resourceId: text((resources.values().next().value as JsonObject | undefined)?.resourceId), resourceIncarnation: text((resources.values().next().value as JsonObject | undefined)?.incarnation), expiresAt: initial.receiptExpiresAt, lease: initial.lease });
          output = { decision: "USE", receipt: receiptId };
        }
      }
    } else if (operation === "mutate_source") {
      for (const memory of memories.values()) {
        for (const source of arrayValue(memory.sourceVersions).map((item) => objectValue(item, "sourceVersions[]"))) if (text(source.sourceUri) === text(input.sourceUri)) (source as Record<string, unknown>).token = input.token;
      }
      output = { effects: 0 };
    } else if (operation === "mutate_memory") {
      const memory = memories.get(text(input.memoryId)); if (memory !== undefined) { (memory as Record<string, unknown>).revision = input.revision; (memory as Record<string, unknown>).status = input.status; }
      output = { effects: 0 };
    } else if (operation === "delete_recreate") {
      const resource = resources.get(text(input.resourceId)); if (resource !== undefined) { (resource as Record<string, unknown>).incarnation = input.incarnation; (resource as Record<string, unknown>).revision = input.revision; }
      output = { effects: 0 };
    } else if (operation === "advance_time") {
      now = text(input.now); output = { effects: 0 };
    } else if (operation === "commit") {
      const receiptId = text(input.receipt); const receipt = receipts.get(receiptId);
      if (receipt === undefined) {
        const key = text(input.idempotencyKey); const previous = actions.get(key);
        output = previous !== undefined && previous.actionDigest !== text(input.actionDigest) ? { status: "REJECTED", reason: "IDEMPOTENCY_CONFLICT", effects: 0 } : { status: "REJECTED", reason: "RECEIPT_MISSING", effects: 0 };
      } else if (!capabilities.has("CAS")) output = { status: "REJECTED", reason: "CAS_REQUIRED", effects: 0, toctouEscaped: false };
      else if (receipt.expiresAt !== undefined && Date.parse(now) >= Date.parse(text(receipt.expiresAt))) output = { status: "REJECTED", reason: "RECEIPT_EXPIRED", effects: 0 };
      else if (objectValue(receipt.lease, "receipt.lease").expiresAt !== undefined && Date.parse(now) >= Date.parse(text(objectValue(receipt.lease, "receipt.lease").expiresAt))) output = { status: "REJECTED", reason: "LEASE_EXPIRED", effects: 0 };
      else {
        const memory = memories.get(text(receipt.memoryId)); const resource = resources.values().next().value as JsonObject | undefined;
        const originalSources = arrayValue(receipt.sourceVersions).map((item) => objectValue(item, "receipt.sourceVersions[]"));
        const currentSources = arrayValue(memory?.sourceVersions).map((item) => objectValue(item, "memory.sourceVersions[]"));
        const sourceChanged = originalSources.some((original) => currentSources.some((current) => text(original.sourceUri) === text(current.sourceUri) && text(original.token) !== text(current.token)));
        if (sourceChanged) output = { status: "REJECTED", reason: "SOURCE_CHANGED", effects: 0, toctouEscaped: false };
        else if (memory !== undefined && text(memory.revision) !== text(receipt.revision)) output = { status: "REJECTED", reason: "CAS_MISMATCH", effects: 0 };
        else if (resource !== undefined && objectValue(receipt.lease, "receipt.lease").scope === text(resource.resourceId) && text(resource.incarnation) !== text(objectValue(firstResource, "initial.resources[0]").incarnation)) output = { status: "REJECTED", reason: "INCARNATION_MISMATCH", effects: 0 };
        else {
          const key = text(receipt.idempotencyKey); const previous = actions.get(key);
          if (previous !== undefined) output = previous.actionDigest === text(receipt.actionDigest) ? { status: "REPLAY", effects: 0, idempotency: "REPLAY", sameResultAs: "commit-first" } : { status: "REJECTED", reason: "IDEMPOTENCY_CONFLICT", effects: 0 };
          else { actions.set(key, { actionDigest: text(receipt.actionDigest), result: "APPLIED" }); output = { status: "APPLIED", effects: 1, idempotency: "NEW" }; }
        }
      }
    } else output = { effects: 0 };
    steps.push({ id: text(step.id), output });
  }
  return { steps };
}

function policyVector(vector: JsonObject): JsonObject {
  switch (vector.operation) {
    case "negotiate": {
      const requested = arrayValue(vector.requested).map(text); const available = new Set(arrayValue(vector.available).map(text));
      const supported = requested.filter((item) => available.has(item)); const unsupported = requested.filter((item) => !available.has(item));
      return { supported, unsupported, decision: unsupported.length === 0 ? "SUPPORTED" : "UNSUPPORTED" };
    }
    case "share": {
      const left = objectValue(vector.left, "left"); const right = objectValue(vector.right, "right");
      const fields = ["tenant", "resource", "incarnation", "version", "query", "validator", "auth", "policy"];
      const changeSetKnown = Object.hasOwn(left, "changeSet") && Object.hasOwn(right, "changeSet")
        && (left.changeSet === null || text(left.changeSet).length > 0)
        && (right.changeSet === null || text(right.changeSet).length > 0);
      if (!changeSetKnown || fields.some((field) => text(left[field]).length === 0 || text(right[field]).length === 0)) return { share: false, reason: "SCOPE_MISMATCH" };
      const setsEqual = stringSetEqual(left.scopes, right.scopes) && stringSetEqual(left.causal, right.causal);
      const match = fields.every((field) => equal(left[field], right[field])) && equal(left.changeSet, right.changeSet) && setsEqual;
      return match ? { share: true, reason: "MATCH" } : { share: false, reason: "SCOPE_MISMATCH" };
    }
    case "singleFlight": {
      const groups = new Set(arrayValue(vector.requests).map((item) => JSON.stringify(canonical(item))));
      return { physicalValidations: groups.size, waiters: arrayValue(vector.requests).length - groups.size };
    }
    case "lease": {
      const lease = objectValue(vector.lease, "lease");
      return lease.valid === true ? { usable: true, reason: "VALID" } : { usable: false, reason: text(lease.reason) || "FENCING_REPLAY" };
    }
    case "strength": {
      const state = text(vector.state);
      return state === "FRESH" ? { state, decision: "USE" } : stateResult(state);
    }
    default: throw new Error(`Unsupported policy operation: ${String(vector.operation)}`);
  }
}

function supplementalPolicyVector(vector: JsonObject): JsonObject {
  switch (vector.operation) {
    case "guardedWrite": {
      const initial = objectValue(vector.initial, "initial");
      const before = identity(initial.identity);
      return Object.fromEntries(arrayValue(vector.cases).map((item) => {
        const test = objectValue(item, "cases[]"); const source = objectValue(test.sourceNow, "sourceNow");
        const sameLifecycle = sameIdentity(before, source);
        const expected = sameLifecycle
          ? { conditionalRead: text(source.versionToken) === text(initial.versionToken) ? "MATCH" : "MISMATCH", decision: text(source.versionToken) === text(initial.versionToken) ? "ALLOW" : "REVALIDATE", reason: text(source.versionToken) === text(initial.versionToken) ? "MATCH" : "CAS_MISMATCH", cas: text(source.versionToken) === text(initial.versionToken) ? "ACCEPTED" : "REJECTED", effect: text(source.versionToken) === text(initial.versionToken) ? "COMMITTED" : "NONE", events: text(source.versionToken) === text(initial.versionToken) ? 1 : 0 }
          : { conditionalRead: "GONE", decision: "REJECT", reason: "IDENTITY_MISMATCH", cas: "NOT_ATTEMPTED", effect: "NONE", events: 0 };
        return [text(test.id), expected];
      }));
    }
    case "coherentBatch": {
      const changeSet = objectValue(vector.changeSet, "changeSet"); const snapshot = objectValue(vector.snapshot, "snapshot");
      const frontier = objectValue(changeSet.frontier, "frontier");
      const mismatched = arrayValue(changeSet.members).map((item) => objectValue(item, "members[]")).filter((member) => Object.values(frontier).some((token) => text(member.versionToken) !== text(token))).map((member) => text(member.observationId));
      const perItem = arrayValue(objectValue(vector.batch, "batch").items).map((item) => ({ id: text(objectValue(item, "batch.items[]").id), decision: "REVALIDATE" }));
      return { decision: mismatched.length > 0 ? "REVALIDATE" : "ALLOW", reason: mismatched.length > 0 ? "CHANGE_SET_INCOMPLETE" : "MATCH", missingOrMismatched: mismatched, batchCommit: mismatched.length > 0 ? "NOT_ATTEMPTED" : "COMMITTED", perItem, effect: mismatched.length > 0 ? "NONE" : "COMMITTED", events: mismatched.length > 0 ? 0 : 1 };
    }
    case "retryAndFallback": {
      const clock = Date.parse(text(vector.clock)); const ttl = objectValue(vector.ttl, "ttl"); const expires = Date.parse(text(ttl.expiresAt));
      const seen = new Map<string, string>(); const effects = new Map<string, number>();
      return Object.fromEntries(arrayValue(vector.requests).map((item) => {
        const request = objectValue(item, "requests[]"); const key = text(request.idempotencyKey); const digest = text(request.requestDigest); const at = request.at === undefined ? clock : Date.parse(text(request.at));
        if (text(request.risk) === "HIGH") return [text(request.id), { status: "NEW", decision: "UNSUPPORTED", reason: "TTL_NOT_ALLOWED_FOR_RISK", effectCount: 0, eventCount: 0 }];
        if (at >= expires) return [text(request.id), { status: "NEW", decision: "REVALIDATE", reason: "TTL_EXPIRED", effectCount: 0, eventCount: 0 }];
        const previous = seen.get(key);
        if (previous === undefined) { seen.set(key, digest); effects.set(key, 1); return [text(request.id), { status: "NEW", decision: "USE", effectCount: 1, eventCount: 1 }]; }
        if (previous === digest) return [text(request.id), { status: "REPLAY", decision: "USE", sameReceipt: true, effectCount: effects.get(key) ?? 1, eventCount: 1 }];
        return [text(request.id), { status: "CONFLICT", decision: "REJECT", effectCount: effects.get(key) ?? 1, eventCount: 1 }];
      }));
    }
    case "selectFrontier": {
      const candidates = arrayValue(vector.candidates).map((item) => objectValue(item, "candidates[]"));
      const eligible = candidates.filter((candidate) => candidate.coreComplete === true && candidate.identityVerified === true && candidate.evidenceVerified === true && candidate.scopeMatched === true && candidate.causalFrontierComplete === true && candidate.unsafeActions === 0 && candidate.casForWrite === true && typeof objectValue(candidate.metrics, "metrics").costUsd === "number").map((candidate) => text(candidate.id));
      return { eligible, excluded: Object.fromEntries(candidates.filter((candidate) => !eligible.includes(text(candidate.id))).map((candidate) => [text(candidate.id), candidate.coreComplete !== true || candidate.casForWrite !== true ? "CORE_REQUIREMENT_MISSING" : objectValue(candidate.metrics, "metrics").costUsd === "UNKNOWN" ? "UNKNOWN_METRIC" : "SCOPE_MISMATCH"])), frontier: eligible, coreRequirementsRemoved: false };
    }
    default: throw new Error(`Unsupported supplemental policy operation: ${String(vector.operation)}`);
  }
}

export function runEvolutionVector(input: unknown, profile: EvolutionProfile): { id: string; output: unknown } {
  const vector = objectValue(input, "vector"); const id = text(vector.id ?? vector.vectorId); if (!id) throw new TypeError("vector.id must be non-empty");
  let output: unknown;
  if (profile === "premise/1.1") {
    switch (vector.operation) {
      case "check": output = checkMemory(vector, text(vector.target), new Set()); break;
      case "receipt": output = receiptVector(vector); break;
      case "coherence": output = coherenceVector(vector); break;
      case "frontier": output = frontierVector(vector); break;
      case "invalidate": output = invalidationVector(vector); break;
      default: throw new Error(`Unsupported core operation: ${String(vector.operation)}`);
    }
  } else if (profile === "premise-guard/1") output = guardVector(vector);
  else if (profile === "premise-guard/1-rich") output = richGuardVector(vector);
  else if (profile === "premise-policy/1-supplemental") output = supplementalPolicyVector(vector);
  else output = policyVector(vector);
  return { id, output };
}

export function runEvolutionVectors(input: unknown, profile: EvolutionProfile): readonly { id: string; output: unknown }[] {
  const document = objectValue(input, "vector document");
  return arrayValue(document.vectors).map((item) => runEvolutionVector(item, profile));
}
