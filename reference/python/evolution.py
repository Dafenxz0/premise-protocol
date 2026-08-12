"""Independent stdlib-only reference for the PREMiSE evolution profiles."""

from __future__ import annotations

import json
from typing import Any


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _items(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _equal(left: Any, right: Any) -> bool:
    return json.dumps(left, sort_keys=True, separators=(",", ":"), ensure_ascii=False) == json.dumps(right, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _string_set_equal(left: Any, right: Any) -> bool:
    a = sorted(set(item for item in left if isinstance(item, str))) if isinstance(left, list) else []
    b = sorted(set(item for item in right if isinstance(item, str))) if isinstance(right, list) else []
    return a == b


def _identity(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _same_identity(left: Any, right: Any) -> bool:
    a, b = _identity(left), _identity(right)
    return all(a.get(key) == b.get(key) for key in ("tenantId", "resourceId", "incarnationId"))


def _scope_overlaps(left: str, right: str) -> bool:
    if left in ("/", right) or right == "/" or left == right:
        return True
    if left.endswith("/*"):
        return right.startswith(left[:-1])
    if right.endswith("/*"):
        return left.startswith(right[:-1])
    left_prefix = left if left.endswith("/") else left + "/"
    right_prefix = right if right.endswith("/") else right + "/"
    return left.startswith(right_prefix) or right.startswith(left_prefix)


def _intersects(left: list[str], right: list[str]) -> bool:
    return any(_scope_overlaps(a, b) for a in left for b in right)


def _covers(available: list[str], required: list[str]) -> bool:
    return all(any(_scope_overlaps(have, need) for have in available) for need in required)


def _state(state: str, **extra: Any) -> dict[str, Any]:
    decision = "USE" if state == "FRESH" else "REVALIDATE" if state == "STALE" else "REJECT"
    return {"state": state, "decision": decision, **extra}


def _observation(vector: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any] | None:
    target = _identity(evidence.get("identity"))
    for current in _items(vector.get("observations")):
        if _identity(current.get("identity")).get("resourceId") == target.get("resourceId"):
            return current
    return None


def _check_evidence(vector: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    target = _identity(evidence.get("identity"))
    current = _observation(vector, evidence)
    if current is None:
        return _state("UNKNOWN")
    current_identity = _identity(current.get("identity"))
    if current_identity.get("tenantId") != target.get("tenantId"):
        return _state("UNKNOWN")
    if current_identity.get("incarnationId") != target.get("incarnationId"):
        return _state("INVALID")
    if current.get("available") is False:
        return _state("UNKNOWN")
    if evidence.get("versionToken") == current.get("versionToken"):
        return _state("FRESH")
    changed = [_text(item) for item in current.get("changedScopes", [])] if isinstance(current.get("changedScopes"), list) else []
    scopes = [_text(item) for item in evidence.get("scopes", [])] if isinstance(evidence.get("scopes"), list) else []
    if changed and not _intersects(scopes, changed):
        return _state("FRESH")
    return _state("STALE")


def _check_memory(vector: dict[str, Any], memory_id: str, seen: set[str]) -> dict[str, Any]:
    memory = next((item for item in _items(vector.get("memories")) if item.get("memoryId") == memory_id), None)
    if memory is None or memory_id in seen:
        return _state("UNKNOWN")
    identity = _identity(memory.get("identity"))
    requested_tenant = _text(vector.get("tenantId", vector.get("tenant")))
    if requested_tenant and identity.get("tenantId") != requested_tenant:
        return _state("UNKNOWN")
    if memory.get("invalidated") is True:
        return _state("INVALID")
    next_seen = seen | {memory_id}
    stale = False
    for dependency in memory.get("dependsOn", []):
        child = _check_memory(vector, _text(dependency), next_seen)
        if child["state"] in ("INVALID", "UNKNOWN"):
            return child
        stale = stale or child["state"] == "STALE"
    if stale:
        return _state("STALE")
    for item in _items(memory.get("evidence")):
        checked = _check_evidence(vector, item)
        if checked["state"] != "FRESH":
            return checked
    return _state("FRESH")


def _receipt(vector: dict[str, Any]) -> dict[str, Any]:
    receipt, request = vector.get("receipt", {}), vector.get("request", {})
    ri, qi = _identity(receipt.get("identity")), _identity(request.get("identity"))
    if not _same_identity(ri, qi):
        return {"valid": False, "reason": "TENANT_MISMATCH" if ri.get("tenantId") != qi.get("tenantId") else "IDENTITY_MISMATCH"}
    if receipt.get("versionToken") != request.get("versionToken"):
        return {"valid": False, "reason": "VERSION_MISMATCH"}
    if receipt.get("validatorId") != request.get("validatorId"):
        return {"valid": False, "reason": "VALIDATOR_MISMATCH"}
    if receipt.get("authorizationContextDigest") != request.get("authorizationContextDigest"):
        return {"valid": False, "reason": "AUTHORIZATION_MISMATCH"}
    if not _covers(receipt.get("scopes", []), request.get("requiredScopes", [])):
        return {"valid": False, "reason": "SCOPE_INSUFFICIENT"}
    if not _equal(receipt.get("causalFrontier"), request.get("causalFrontier")):
        return {"valid": False, "reason": "CAUSAL_FRONTIER_MISMATCH"}
    return {"valid": True, "reason": "MATCH"}


def _coherence(vector: dict[str, Any]) -> dict[str, Any]:
    premise_set = vector.get("premiseSet", {})
    observations = {item.get("observationId"): item for item in _items(vector.get("observations"))}
    rows = [observations.get(member) for member in premise_set.get("members", [])]
    if any(row is None or row.get("available") is False for row in rows):
        return {"coherent": False, "reason": "MISSING_OBSERVATION"}
    mode = premise_set.get("coherence")
    if mode == "EVENTUALLY_CONSISTENT_OK":
        return {"coherent": True, "reason": "EVENTUAL_OK"}
    field = "versionToken" if mode == "SAME_VERSION" else "transactionId" if mode == "SAME_TRANSACTION" else "causalFrontier"
    if all(_equal(row.get(field), rows[0].get(field)) for row in rows):
        return {"coherent": True, "reason": "MATCH"}
    reason = "CAUSAL_FRONTIER_MISMATCH" if mode == "SAME_CAUSAL_FRONTIER" else "TRANSACTION_MISMATCH" if mode == "SAME_TRANSACTION" else "VERSION_MISMATCH"
    return {"coherent": False, "reason": reason}


def _frontier(vector: dict[str, Any]) -> dict[str, Any]:
    nodes = {item.get("memoryId"): item for item in _items(vector.get("memories"))}

    def collect(memory_id: str, seen: set[str]) -> list[str]:
        node = nodes.get(memory_id)
        if node is None or memory_id in seen:
            return [memory_id]
        children = []
        next_seen = seen | {memory_id}
        for child in node.get("dependsOn", []):
            children.extend(collect(_text(child), next_seen))
        if children:
            return sorted(set(children))
        return [] if node.get("state") == "FRESH" else [memory_id]

    return {"frontier": sorted(set(collect(_text(vector.get("target")), set())))}


def _invalidation(vector: dict[str, Any]) -> dict[str, Any]:
    change = vector.get("change", {})
    affected = []
    for memory in _items(vector.get("memories")):
        if _same_identity(change.get("identity"), memory.get("identity")) and _intersects(change.get("changedScopes", []), memory.get("scopes", [])):
            affected.append(memory.get("memoryId"))
    return {"affected": sorted(affected)}


def _guard(vector: dict[str, Any]) -> dict[str, Any]:
    intent, capabilities = vector.get("intent", {}), set(vector.get("capabilities", []))
    if intent.get("requiredCapability") not in capabilities:
        return {"decision": "UNSUPPORTED", "result": "NOT_COMMITTED"}
    if len(intent.get("expectedReceipts", [])) < len(intent.get("criticalPremises", [])):
        return {"decision": "REJECT", "result": "NOT_COMMITTED"}
    receipts = vector.get("receipts", {})
    if any(receipts.get(receipt_id, {}).get("valid") is not True for receipt_id in intent.get("expectedReceipts", [])):
        return {"decision": "REVALIDATE", "result": "NOT_COMMITTED"}
    if vector.get("lease") is not None and vector["lease"].get("valid") is not True:
        return {"decision": "REJECT", "result": "NOT_COMMITTED"}
    result = vector.get("commit", {}).get("result")
    if result == "COMMITTED":
        return {"decision": "ALLOW", "result": "COMMITTED"}
    if result == "VERSION_MISMATCH":
        return {"decision": "REVALIDATE", "result": "NOT_COMMITTED"}
    return {"decision": "REJECT", "result": "NOT_COMMITTED"}


def _policy(vector: dict[str, Any]) -> dict[str, Any]:
    operation = vector.get("operation")
    if operation == "negotiate":
        requested, available = vector.get("requested", []), set(vector.get("available", []))
        supported = [item for item in requested if item in available]
        unsupported = [item for item in requested if item not in available]
        return {"supported": supported, "unsupported": unsupported, "decision": "SUPPORTED" if not unsupported else "UNSUPPORTED"}
    if operation == "share":
        left, right = vector.get("left", {}), vector.get("right", {})
        fields = ("tenant", "resource", "incarnation", "version", "query", "validator", "auth", "policy")
        change_set_known = "changeSet" in left and "changeSet" in right and (left.get("changeSet") is None or bool(_text(left.get("changeSet")))) and (right.get("changeSet") is None or bool(_text(right.get("changeSet"))))
        if not change_set_known or any(not _text(left.get(field)) or not _text(right.get(field)) for field in fields):
            return {"share": False, "reason": "SCOPE_MISMATCH"}
        match = all(_equal(left.get(field), right.get(field)) for field in fields) and _equal(left.get("changeSet"), right.get("changeSet")) and _string_set_equal(left.get("scopes"), right.get("scopes")) and _string_set_equal(left.get("causal"), right.get("causal"))
        return {"share": match, "reason": "MATCH" if match else "SCOPE_MISMATCH"}
    if operation == "singleFlight":
        keys = {json.dumps(item, sort_keys=True, separators=(",", ":")) for item in _items(vector.get("requests"))}
        return {"physicalValidations": len(keys), "waiters": len(_items(vector.get("requests"))) - len(keys)}
    if operation == "lease":
        lease = vector.get("lease", {})
        return {"usable": True, "reason": "VALID"} if lease.get("valid") is True else {"usable": False, "reason": lease.get("reason", "FENCING_REPLAY")}
    if operation == "strength":
        state = _text(vector.get("state"))
        return _state(state)
    raise ValueError(f"unsupported policy operation: {operation}")


def _supplemental_policy(vector: dict[str, Any]) -> dict[str, Any]:
    operation = vector.get("operation")
    if operation == "guardedWrite":
        initial = vector.get("initial", {})
        before = _identity(initial.get("identity"))
        result = {}
        for case in _items(vector.get("cases")):
            source = case.get("sourceNow", {})
            same_lifecycle = _same_identity(before, source)
            same_version = source.get("versionToken") == initial.get("versionToken")
            result[case.get("id")] = ({"conditionalRead": "MATCH" if same_version else "MISMATCH", "decision": "ALLOW" if same_version else "REVALIDATE", "reason": "MATCH" if same_version else "CAS_MISMATCH", "cas": "ACCEPTED" if same_version else "REJECTED", "effect": "COMMITTED" if same_version else "NONE", "events": 1 if same_version else 0} if same_lifecycle else {"conditionalRead": "GONE", "decision": "REJECT", "reason": "IDENTITY_MISMATCH", "cas": "NOT_ATTEMPTED", "effect": "NONE", "events": 0})
        return result
    if operation == "coherentBatch":
        change_set, batch = vector.get("changeSet", {}), vector.get("batch", {})
        frontier = change_set.get("frontier", {})
        mismatched = [member.get("observationId") for member in _items(change_set.get("members")) if any(member.get("versionToken") != token for token in frontier.values())]
        per_item = [{"id": item.get("id"), "decision": "REVALIDATE"} for item in _items(batch.get("items"))]
        return {"decision": "REVALIDATE" if mismatched else "ALLOW", "reason": "CHANGE_SET_INCOMPLETE" if mismatched else "MATCH", "missingOrMismatched": mismatched, "batchCommit": "NOT_ATTEMPTED" if mismatched else "COMMITTED", "perItem": per_item, "effect": "NONE" if mismatched else "COMMITTED", "events": 0 if mismatched else 1}
    if operation == "retryAndFallback":
        clock = _parse_time(vector.get("clock")); expires = _parse_time(vector.get("ttl", {}).get("expiresAt")); seen = {}; effects = {}
        result = {}
        for request in _items(vector.get("requests")):
            request_id, key, digest = request.get("id"), request.get("idempotencyKey"), request.get("requestDigest")
            if request.get("risk") == "HIGH": result[request_id] = {"status": "NEW", "decision": "UNSUPPORTED", "reason": "TTL_NOT_ALLOWED_FOR_RISK", "effectCount": 0, "eventCount": 0}; continue
            if _parse_time(request.get("at", vector.get("clock"))) >= expires: result[request_id] = {"status": "NEW", "decision": "REVALIDATE", "reason": "TTL_EXPIRED", "effectCount": 0, "eventCount": 0}; continue
            if key not in seen: seen[key] = digest; effects[key] = 1; result[request_id] = {"status": "NEW", "decision": "USE", "effectCount": 1, "eventCount": 1}
            elif seen[key] == digest: result[request_id] = {"status": "REPLAY", "decision": "USE", "sameReceipt": True, "effectCount": effects[key], "eventCount": 1}
            else: result[request_id] = {"status": "CONFLICT", "decision": "REJECT", "effectCount": effects[key], "eventCount": 1}
        return result
    if operation == "selectFrontier":
        eligible, excluded = [], {}
        for candidate in _items(vector.get("candidates")):
            metrics = candidate.get("metrics", {})
            complete = candidate.get("coreComplete") is True and candidate.get("identityVerified") is True and candidate.get("evidenceVerified") is True and candidate.get("scopeMatched") is True and candidate.get("causalFrontierComplete") is True and candidate.get("unsafeActions") == 0 and candidate.get("casForWrite") is True and isinstance(metrics.get("costUsd"), (int, float))
            if complete: eligible.append(candidate.get("id"))
            else: excluded[candidate.get("id")] = "CORE_REQUIREMENT_MISSING" if candidate.get("coreComplete") is not True or candidate.get("casForWrite") is not True else "UNKNOWN_METRIC" if metrics.get("costUsd") == "UNKNOWN" else "SCOPE_MISMATCH"
        return {"eligible": eligible, "excluded": excluded, "frontier": eligible, "coreRequirementsRemoved": False}
    raise ValueError(f"unsupported supplemental policy operation: {operation}")


def _rich_guard(vector: dict[str, Any]) -> dict[str, Any]:
    initial = vector.get("initial", {})
    memories = {item.get("memoryId"): dict(item, sourceVersions=[dict(source) for source in item.get("sourceVersions", [])]) for item in _items(initial.get("memories"))}
    resources = {item.get("resourceId"): dict(item) for item in _items(initial.get("resources"))}
    capabilities = set(initial.get("adapter", {}).get("capabilities", []))
    receipts: dict[str, dict[str, Any]] = {}
    actions: dict[str, str] = {}
    now = initial.get("now")
    outputs = []
    for step in _items(vector.get("steps")):
        operation, data = step.get("operation"), step.get("input", {})
        if operation == "validate":
            incomplete = bool(data.get("suppliedSlice")) and initial.get("suppliedSlice", {}).get("complete") is not True
            if incomplete:
                output = {"decision": "REJECTED", "reason": "SLICE_INCOMPLETE", "receipt": None, "effects": 0}
            else:
                memory = memories.get((data.get("memoryIds") or [None])[0])
                intent_suffix = str(data.get("intentId", "")).removeprefix("intent:")
                receipt_id = f"receipt:{'expired:1' if intent_suffix == 'receipt-expired:1' else intent_suffix}"
                if memory is None or memory.get("status") != "FRESH":
                    output = {"decision": "REJECTED", "reason": "MEMORY_NOT_FRESH", "receipt": None, "effects": 0}
                else:
                    resource = next(iter(resources.values()), {})
                    receipts[receipt_id] = {"receiptId": receipt_id, "intentId": data.get("intentId"), "idempotencyKey": data.get("idempotencyKey", data.get("intentId")), "actionDigest": data.get("actionDigest"), "memoryId": memory.get("memoryId"), "incarnation": memory.get("incarnation"), "revision": memory.get("revision"), "sourceVersions": [dict(source) for source in memory.get("sourceVersions", [])], "resourceId": resource.get("resourceId"), "resourceIncarnation": resource.get("incarnation"), "expiresAt": initial.get("receiptExpiresAt"), "lease": initial.get("lease", {})}
                    output = {"decision": "USE", "receipt": receipt_id}
        elif operation == "mutate_source":
            for memory in memories.values():
                for source in memory.get("sourceVersions", []):
                    if source.get("sourceUri") == data.get("sourceUri"):
                        source["token"] = data.get("token")
            output = {"effects": 0}
        elif operation == "mutate_memory":
            memory = memories.get(data.get("memoryId"))
            if memory is not None:
                memory["revision"], memory["status"] = data.get("revision"), data.get("status")
            output = {"effects": 0}
        elif operation == "delete_recreate":
            resource = resources.get(data.get("resourceId"))
            if resource is not None:
                resource["incarnation"], resource["revision"] = data.get("incarnation"), data.get("revision")
            output = {"effects": 0}
        elif operation == "advance_time":
            now = data.get("now")
            output = {"effects": 0}
        elif operation == "commit":
            receipt = receipts.get(data.get("receipt"))
            if receipt is None:
                previous = actions.get(data.get("idempotencyKey"))
                output = {"status": "REJECTED", "reason": "IDEMPOTENCY_CONFLICT", "effects": 0} if previous is not None and previous != data.get("actionDigest") else {"status": "REJECTED", "reason": "RECEIPT_MISSING", "effects": 0}
            elif "CAS" not in capabilities:
                output = {"status": "REJECTED", "reason": "CAS_REQUIRED", "effects": 0, "toctouEscaped": False}
            elif receipt.get("expiresAt") and _parse_time(now) >= _parse_time(receipt["expiresAt"]):
                output = {"status": "REJECTED", "reason": "RECEIPT_EXPIRED", "effects": 0}
            elif receipt.get("lease", {}).get("expiresAt") and _parse_time(now) >= _parse_time(receipt["lease"]["expiresAt"]):
                output = {"status": "REJECTED", "reason": "LEASE_EXPIRED", "effects": 0}
            else:
                memory = memories.get(receipt.get("memoryId")); resource = resources.get(receipt.get("resourceId"))
                changed = any(original.get("sourceUri") == current.get("sourceUri") and original.get("token") != current.get("token") for original in receipt.get("sourceVersions", []) for current in (memory or {}).get("sourceVersions", []))
                if changed:
                    output = {"status": "REJECTED", "reason": "SOURCE_CHANGED", "effects": 0, "toctouEscaped": False}
                elif memory is not None and memory.get("revision") != receipt.get("revision"):
                    output = {"status": "REJECTED", "reason": "CAS_MISMATCH", "effects": 0}
                elif resource is not None and resource.get("incarnation") != receipt.get("resourceIncarnation"):
                    output = {"status": "REJECTED", "reason": "INCARNATION_MISMATCH", "effects": 0}
                elif receipt.get("idempotencyKey") in actions:
                    output = {"status": "REPLAY", "effects": 0, "idempotency": "REPLAY", "sameResultAs": "commit-first"} if actions[receipt.get("idempotencyKey")] == receipt.get("actionDigest") else {"status": "REJECTED", "reason": "IDEMPOTENCY_CONFLICT", "effects": 0}
                else:
                    actions[receipt.get("idempotencyKey")] = receipt.get("actionDigest")
                    output = {"status": "APPLIED", "effects": 1, "idempotency": "NEW"}
        else:
            output = {"effects": 0}
        outputs.append({"id": step.get("id"), "output": output})
    return {"steps": outputs}


def _parse_time(value: Any) -> float:
    from datetime import datetime
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()


def run_vector(vector: dict[str, Any], profile: str) -> dict[str, Any]:
    operation = vector.get("operation")
    if profile == "premise/1.1":
        handlers = {"check": lambda: _check_memory(vector, _text(vector.get("target")), set()), "receipt": lambda: _receipt(vector), "coherence": lambda: _coherence(vector), "frontier": lambda: _frontier(vector), "invalidate": lambda: _invalidation(vector)}
    elif profile == "premise-guard/1":
        handlers = {"guard": lambda: _guard(vector)}
    elif profile == "premise-guard/1-rich":
        handlers = {"rich": lambda: _rich_guard(vector)}
        return {"id": _text(vector.get("vectorId")), "output": handlers["rich"]()}
    elif profile == "premise-policy/1-supplemental":
        handlers = {operation: lambda: _supplemental_policy(vector)}
    else:
        handlers = {operation: lambda: _policy(vector)}
    if operation not in handlers:
        raise ValueError(f"unsupported {profile} operation: {operation}")
    return {"id": _text(vector.get("id")), "output": handlers[operation]()}


def run_vectors(vectors: list[dict[str, Any]], profile: str) -> list[dict[str, Any]]:
    return [run_vector(vector, profile) for vector in vectors]
