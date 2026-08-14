"""Independent, stdlib-only reference for the PREMiSE NEXT primitives.

This module is deliberately a small pure-data interpreter.  It does not import
the TypeScript runtime, perform I/O, contact a connector, or keep process-wide
state.  The JSON vectors under ``spec/premise-next/vectors`` are its portable
contract for:

* negative premises (``ABSENT`` / ``STALE`` / ``UNKNOWN``),
* predicate dependencies (``PRESERVED`` / ``INVALIDATED`` / ``UNKNOWN``),
* safe receipt subsumption, and
* the explicit guarded ``check -> revalidate -> act`` outcome chain.

Unknown or malformed input is intentionally handled conservatively.  This is
an executable reference for decisions, not a connector, cache, or authority
over a source of truth.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence


JsonObject = Mapping[str, Any]
_MISSING = object()


def _object(value: Any) -> JsonObject:
    if not isinstance(value, Mapping):
        raise ValueError("expected an object")
    return value


def _non_empty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _required_text(value: Any, name: str) -> str:
    if not _non_empty(value):
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _timestamp(value: Any, name: str) -> float:
    text = _required_text(value, name)
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _canonical(value: Any) -> str:
    """Canonical JSON for the finite JSON values accepted by the vectors."""

    def validate(item: Any) -> None:
        if isinstance(item, float) and (not math.isfinite(item) or (item == 0 and math.copysign(1.0, item) < 0)):
            raise ValueError("non-finite or negative-zero numbers are not portable JSON")
        if isinstance(item, Mapping):
            for child in item.values():
                validate(child)
        elif isinstance(item, list):
            for child in item:
                validate(child)

    validate(value)

    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _version(value: Any) -> dict[str, str]:
    version = _object(value)
    scheme = _required_text(version.get("scheme"), "version.scheme")
    token = _required_text(version.get("token"), "version.token")
    return {"scheme": scheme, "token": token}


def _same_version(left: Any, right: Any) -> bool:
    try:
        a, b = _version(left), _version(right)
    except (TypeError, ValueError):
        return False
    return a == b


def _resource(value: Any) -> dict[str, str]:
    resource = _object(value)
    return {
        "tenantId": _required_text(resource.get("tenantId"), "tenantId"),
        "resource": _required_text(resource.get("resource"), "resource"),
    }


def _same_resource(left: Any, right: Any) -> bool:
    try:
        return _resource(left) == _resource(right)
    except (TypeError, ValueError):
        return False


# ---------------------------------------------------------------------------
# Negative premises

_NEGATIVE_SCOPE_FIELDS = (
    "tenantId",
    "resource",
    "incarnationId",
    "queryDigest",
    "frontierDigest",
    "authorizationContextDigest",
)


def _negative_scope(value: Any) -> dict[str, str]:
    scope = _object(value)
    return {field: _required_text(scope.get(field), field) for field in _NEGATIVE_SCOPE_FIELDS}


def _negative_result(state: str, reason: str) -> dict[str, str]:
    decision = "USE" if state == "ABSENT" else "REVALIDATE" if state == "STALE" else "REJECT"
    return {"state": state, "decision": decision, "reason": reason}


def check_negative_premise(
    premise: Any,
    scope: Any,
    now: Any,
    observation: Any | None = None,
) -> dict[str, str]:
    """Check one scoped absence observation without manufacturing absence."""

    try:
        requested = _negative_scope(scope)
        current_time = _timestamp(now, "now")
        if not isinstance(observation, Mapping):
            raise ValueError("authoritative observation is required")
        if "entityPresent" not in observation and "frontierDigest" not in observation and "incarnationId" not in observation:
            raise ValueError("authoritative signal is required")
        if "entityPresent" in observation and not isinstance(observation.get("entityPresent"), bool):
            raise ValueError("entityPresent must be boolean")
        if "frontierDigest" in observation:
            _required_text(observation.get("frontierDigest"), "frontierDigest")
        if "incarnationId" in observation:
            _required_text(observation.get("incarnationId"), "incarnationId")
    except (TypeError, ValueError):
        return _negative_result("UNKNOWN", "INVALID_SCOPE")

    if not isinstance(premise, Mapping):
        return _negative_result("UNKNOWN", "NOT_FOUND")

    premise_scope_value = premise.get("scope", premise)
    try:
        stored = _negative_scope(premise_scope_value)
        observed_at = _timestamp(premise.get("observedAt"), "observedAt")
        expires_at = _timestamp(premise.get("expiresAt"), "expiresAt")
        state = premise.get("state", "ABSENT")
        if state != "ABSENT" or expires_at <= observed_at:
            return _negative_result("UNKNOWN", "INVALID_SCOPE")
    except (TypeError, ValueError):
        return _negative_result("UNKNOWN", "INVALID_SCOPE")

    if stored != requested:
        return _negative_result("UNKNOWN", "NOT_FOUND")
    if current_time < observed_at:
        return _negative_result("UNKNOWN", "INVALID_SCOPE")
    if current_time >= expires_at:
        return _negative_result("UNKNOWN", "EXPIRED")

    current = observation
    # Presence of a JSON key is significant: null is not the same as an
    # omitted observation in the wire contract.
    if "incarnationId" in current and current.get("incarnationId") != stored["incarnationId"]:
        return _negative_result("STALE", "INCARNATION_CHANGED")
    if "frontierDigest" in current and current.get("frontierDigest") != stored["frontierDigest"]:
        return _negative_result("STALE", "FRONTIER_CHANGED")
    if current.get("entityPresent") is True:
        return _negative_result("STALE", "ENTITY_PRESENT")
    return _negative_result("ABSENT", "ABSENT")


# ---------------------------------------------------------------------------
# Predicate dependencies

PREDICATE_SPEC_VERSION = "premise-predicate/1"
_PREDICATE_OPERATORS = {"eq", "neq", "gt", "gte", "lt", "lte", "in", "exists"}


def _valid_predicate(value: Any) -> bool:
    if not isinstance(value, Mapping) or value.get("operator") not in _PREDICATE_OPERATORS:
        return False
    operator = value["operator"]
    if operator != "exists" and "value" not in value:
        return False
    if operator == "in" and (not isinstance(value.get("value"), list) or not value["value"]):
        return False
    if operator == "exists" and "value" in value and not isinstance(value.get("value"), bool):
        return False
    if operator in {"gt", "gte", "lt", "lte"} and (isinstance(value.get("value"), bool) or not isinstance(value.get("value"), (int, float, str))):
        return False
    try:
        if "value" in value:
            _canonical(value.get("value"))
    except (TypeError, ValueError):
        return False
    return True


def _same_value(left: Any, right: Any) -> bool:
    if left is _MISSING or right is _MISSING:
        return False
    try:
        return _canonical(left) == _canonical(right)
    except (TypeError, ValueError):
        return False


def evaluate_predicate(value: Any, predicate: Any, *, value_present: bool = True) -> bool | str:
    """Evaluate the small deterministic predicate vocabulary."""

    if not _valid_predicate(predicate):
        return "UNKNOWN"
    candidate = value if value_present else _MISSING
    operator = predicate["operator"]
    expected = predicate.get("value", _MISSING)
    if operator == "exists":
        return (candidate is not _MISSING and candidate is not None) == predicate.get("value", True)
    if candidate is _MISSING:
        return "UNKNOWN"
    try:
        _canonical(candidate)
    except (TypeError, ValueError):
        return "UNKNOWN"
    if operator == "eq":
        return _same_value(candidate, expected)
    if operator == "neq":
        return not _same_value(candidate, expected)
    if operator == "in":
        return any(_same_value(item, candidate) for item in expected)

    numeric = isinstance(candidate, (int, float)) and not isinstance(candidate, bool)
    expected_numeric = isinstance(expected, (int, float)) and not isinstance(expected, bool)
    strings = isinstance(candidate, str) and isinstance(expected, str)
    if not ((numeric and expected_numeric) or strings):
        return "UNKNOWN"
    if operator == "gt":
        return candidate > expected
    if operator == "gte":
        return candidate >= expected
    if operator == "lt":
        return candidate < expected
    return candidate <= expected


def predicate_semantic_fingerprint(dependency: JsonObject) -> str:
    """Digest only the semantic fields, excluding generated metadata."""

    source = _object(dependency)
    payload = {
        "tenantId": _required_text(source.get("tenantId"), "tenantId"),
        "resourceId": _required_text(source.get("resourceId"), "resourceId"),
        "incarnationId": _required_text(source.get("incarnationId"), "incarnationId"),
        "aspect": _required_text(source.get("aspect"), "aspect"),
        "predicate": source.get("predicate"),
    }
    if not _valid_predicate(payload["predicate"]):
        raise ValueError("invalid predicate")
    return _digest({"domain": PREDICATE_SPEC_VERSION, **payload})


def create_predicate_dependency(dependency: JsonObject) -> dict[str, Any]:
    fingerprint = predicate_semantic_fingerprint(dependency)
    return {
        "specVersion": PREDICATE_SPEC_VERSION,
        "tenantId": dependency["tenantId"],
        "resourceId": dependency["resourceId"],
        "incarnationId": dependency["incarnationId"],
        "aspect": dependency["aspect"],
        "predicate": dependency["predicate"],
        "semanticFingerprint": fingerprint,
    }


def _valid_dependency(dependency: Any) -> bool:
    try:
        item = _object(dependency)
        if item.get("specVersion", PREDICATE_SPEC_VERSION) != PREDICATE_SPEC_VERSION:
            return False
        return item.get("semanticFingerprint") == predicate_semantic_fingerprint(item)
    except (TypeError, ValueError):
        return False


def classify_predicate_change(
    dependency: Any,
    previous_value: Any,
    current_value: Any,
    *,
    previous_present: bool = True,
    current_present: bool = True,
) -> str:
    """Return whether a previously true claim survived a value change."""

    if not _valid_dependency(dependency):
        return "UNKNOWN"
    predicate = dependency["predicate"]
    previous = evaluate_predicate(previous_value, predicate, value_present=previous_present)
    if previous is not True:
        return "UNKNOWN"
    current = evaluate_predicate(current_value, predicate, value_present=current_present)
    return "PRESERVED" if current is True else "INVALIDATED" if current is False else "UNKNOWN"


# ---------------------------------------------------------------------------
# Receipt subsumption

_RECEIPT_STRING_FIELDS = (
    "tenantId",
    "resourceId",
    "incarnationId",
    "versionScheme",
    "versionToken",
    "validatorId",
    "authorizationContextDigest",
    "policyDigest",
    "queryFamily",
)
_RECEIPT_LIST_FIELDS = ("queryParts", "scopes", "causalFrontier")


def _string_set(value: Any, name: str) -> set[str]:
    if not isinstance(value, list) or any(not _non_empty(item) for item in value):
        raise ValueError(f"{name} must contain non-empty strings")
    if value != sorted(set(value)):
        raise ValueError(f"{name} must be sorted and duplicate-free")
    return set(value)


def _receipt_scope(value: Any) -> JsonObject:
    scope = _object(value)
    for field in _RECEIPT_STRING_FIELDS:
        _required_text(scope.get(field), field)
    if scope.get("changeSetDigest") is not None:
        _required_text(scope.get("changeSetDigest"), "changeSetDigest")
    for field in _RECEIPT_LIST_FIELDS:
        _string_set(scope.get(field), field)
    return scope


def _covers(available: set[str], required: set[str]) -> bool:
    return required.issubset(available)


def _receipt_scope_reason(candidate: JsonObject, required: JsonObject, requirement: JsonObject) -> str:
    for field, reason in (
        ("tenantId", "TENANT_MISMATCH"),
        ("resourceId", "RESOURCE_MISMATCH"),
        ("incarnationId", "INCARNATION_MISMATCH"),
        ("versionScheme", "VERSION_SCHEME_MISMATCH"),
        ("versionToken", "VERSION_MISMATCH"),
        ("validatorId", "VALIDATOR_MISMATCH"),
        ("authorizationContextDigest", "AUTHORIZATION_MISMATCH"),
        ("policyDigest", "POLICY_MISMATCH"),
        ("changeSetDigest", "CHANGE_SET_MISMATCH"),
        ("queryFamily", "QUERY_FAMILY_MISMATCH"),
    ):
        if candidate[field] != required[field]:
            return reason
    if not _covers(_string_set(candidate["queryParts"], "candidate.queryParts"), _string_set(requirement["requiredQueryParts"], "requiredQueryParts")):
        return "QUERY_INSUFFICIENT"
    if not _covers(_string_set(candidate["scopes"], "candidate.scopes"), _string_set(requirement["requiredScopes"], "requiredScopes")):
        return "SCOPE_INSUFFICIENT"
    if candidate["causalFrontier"] != required["causalFrontier"]:
        return "FRONTIER_INSUFFICIENT"
    if not _covers(set(required["causalFrontier"]), _string_set(requirement["requiredFrontier"], "requiredFrontier")):
        return "FRONTIER_INSUFFICIENT"
    return "MATCH"


def assess_receipt_subsumption(candidate: JsonObject, requirement: JsonObject) -> dict[str, Any]:
    """Check whether a receipt safely subsumes a narrower requirement."""

    try:
        receipt = _object(candidate)
        requested = _object(requirement)
        _required_text(receipt.get("receiptId"), "receiptId")
        now = _timestamp(requested.get("now"), "now")
        expires_at = _timestamp(receipt.get("expiresAt"), "expiresAt")
        observed_at = _timestamp(receipt.get("observedAt"), "observedAt")
        candidate_scope = _receipt_scope(receipt.get("scope"))
        required_scope = _receipt_scope(requested.get("scope"))
        _string_set(requested.get("requiredQueryParts"), "requiredQueryParts")
        _string_set(requested.get("requiredScopes"), "requiredScopes")
        _string_set(requested.get("requiredFrontier"), "requiredFrontier")
        if expires_at <= observed_at or observed_at > now:
            return {"eligible": False, "reason": "INVALID"}
        if now >= expires_at:
            return {"eligible": False, "reason": "EXPIRED"}
        reason = _receipt_scope_reason(candidate_scope, required_scope, requested)
        if reason != "MATCH":
            return {"eligible": False, "reason": reason}
        return {"eligible": True, "reason": "MATCH", "receipt": dict(receipt)}
    except (TypeError, ValueError, KeyError):
        return {"eligible": False, "reason": "INVALID"}


def select_subsuming_receipt(candidates: Sequence[JsonObject], requirement: JsonObject) -> dict[str, Any]:
    try:
        results = [assess_receipt_subsumption(candidate, requirement) for candidate in candidates]
    except (TypeError, ValueError):
        return {"eligible": False, "reason": "INVALID"}
    eligible = [item for item in results if item.get("eligible") is True and isinstance(item.get("receipt"), Mapping)]
    eligible.sort(key=lambda item: item["receipt"]["receiptId"])
    return eligible[0] if eligible else {"eligible": False, "reason": "INVALID"}


# ---------------------------------------------------------------------------
# Guarded action chain

_CHECK_STATES = {"FRESH", "STALE", "INVALID", "UNKNOWN", "MISSING"}
_REVALIDATION_OUTCOMES = {"FRESH", "CHANGED", "MISSING", "UNKNOWN", "VERSION_MISMATCH"}
_ACTION_OUTCOMES = {"APPLIED", "VERSION_MISMATCH", "REJECTED", "UNKNOWN"}


def _guard_output(
    *,
    ready: bool,
    accepted: bool,
    outcome: str,
    reason: str | None = None,
    expected_version: Any = _MISSING,
    observed_version: Any = _MISSING,
    result: Any = _MISSING,
) -> dict[str, Any]:
    output: dict[str, Any] = {"ready": ready, "accepted": accepted, "outcome": outcome}
    if expected_version is not _MISSING:
        output["expectedVersion"] = expected_version
    if observed_version is not _MISSING:
        output["observedVersion"] = observed_version
    if result is not _MISSING:
        output["result"] = result
    if reason is not None:
        output["reason"] = reason
    return output


def guarded_action(vector: JsonObject) -> dict[str, Any]:
    """Evaluate a guarded action without invoking a side effect."""

    try:
        resource = _resource(vector.get("resource"))
    except (TypeError, ValueError):
        return _guard_output(ready=False, accepted=False, outcome="REJECTED", reason="INVALID_RESOURCE")

    checked = vector.get("check")
    if not isinstance(checked, Mapping) or not _same_resource(checked, resource):
        return _guard_output(ready=False, accepted=False, outcome="UNKNOWN", reason="INVALID_CHECK")
    state = checked.get("state")
    if state not in _CHECK_STATES:
        return _guard_output(ready=False, accepted=False, outcome="UNKNOWN", reason="CHECK_STATE_INVALID")
    if state == "MISSING":
        return _guard_output(ready=False, accepted=False, outcome="MISSING", reason="MISSING_RESOURCE")
    if state == "UNKNOWN":
        return _guard_output(ready=False, accepted=False, outcome="UNKNOWN", reason="UNKNOWN_CHECK")
    if state == "INVALID":
        return _guard_output(ready=False, accepted=False, outcome="REJECTED", reason="INVALID_CHECK_STATE")
    try:
        expected_version = _version(checked.get("version"))
    except (TypeError, ValueError):
        return _guard_output(ready=False, accepted=False, outcome="UNKNOWN", reason="VERSION_REQUIRED")

    revalidated = vector.get("revalidate")
    if not isinstance(revalidated, Mapping) or not _same_resource(revalidated, resource):
        return _guard_output(ready=False, accepted=False, outcome="UNKNOWN", reason="INVALID_REVALIDATION")
    revalidation_outcome = revalidated.get("outcome")
    if revalidation_outcome not in _REVALIDATION_OUTCOMES:
        return _guard_output(ready=False, accepted=False, outcome="UNKNOWN", reason="REVALIDATE_OUTCOME_INVALID")
    observed = _MISSING
    if "observedVersion" in revalidated:
        try:
            observed = _version(revalidated.get("observedVersion"))
        except (TypeError, ValueError):
            return _guard_output(ready=False, accepted=False, outcome="UNKNOWN", reason="REVALIDATE_VERSION_INVALID")
    if revalidation_outcome != "FRESH":
        reason = revalidated.get("reason") if _non_empty(revalidated.get("reason")) else revalidation_outcome
        return _guard_output(
            ready=False,
            accepted=False,
            outcome=revalidation_outcome,
            reason=reason,
            observed_version=observed,
        )
    if observed is _MISSING:
        return _guard_output(ready=False, accepted=False, outcome="UNKNOWN", reason="FRESH_VERSION_REQUIRED")

    action = vector.get("action")
    if not isinstance(action, Mapping):
        return _guard_output(ready=True, accepted=False, outcome="REJECTED", expected_version=observed, reason="INVALID_ACTION")
    idempotency_key = vector.get("idempotencyKey")
    if not _non_empty(idempotency_key):
        return _guard_output(ready=True, accepted=False, outcome="REJECTED", expected_version=observed, reason="IDEMPOTENCY_KEY_REQUIRED")
    if not _same_resource(action, resource):
        return _guard_output(ready=True, accepted=False, outcome="UNKNOWN", expected_version=observed, reason="ACT_RESOURCE_MISMATCH")
    outcome = action.get("outcome")
    if outcome not in _ACTION_OUTCOMES:
        return _guard_output(ready=True, accepted=False, outcome="UNKNOWN", expected_version=observed, reason="ACT_OUTCOME_INVALID")
    action_observed = _MISSING
    if "observedVersion" in action:
        try:
            action_observed = _version(action.get("observedVersion"))
        except (TypeError, ValueError):
            return _guard_output(ready=True, accepted=False, outcome="UNKNOWN", expected_version=observed, reason="ACT_VERSION_INVALID")
    return _guard_output(
        ready=True,
        accepted=outcome == "APPLIED",
        outcome=outcome,
        expected_version=observed,
        observed_version=action_observed,
        result=action.get("result", _MISSING),
        reason=action.get("reason") if _non_empty(action.get("reason")) else None,
    )


# ---------------------------------------------------------------------------
# Portable vector dispatcher

def _decision_view(result: Mapping[str, Any]) -> dict[str, Any]:
    """Strip implementation objects while retaining the conformance decision."""

    output = {key: value for key, value in result.items() if key != "receipt"}
    receipt = result.get("receipt")
    if isinstance(receipt, Mapping):
        output["receiptId"] = receipt.get("receiptId")
    return output


def run_vector(vector: JsonObject) -> dict[str, Any]:
    """Run one ``premise-next`` vector and return its deterministic output."""

    item = _object(vector)
    _required_text(item.get("id"), "vector.id")
    operation = item.get("operation")
    if operation in {"negative", "negative_check"}:
        return check_negative_premise(item.get("premise"), item.get("scope"), item.get("now"), item.get("observation"))
    if operation in {"predicate", "predicate_change"}:
        dependency = item.get("dependency")
        if isinstance(dependency, Mapping) and "semanticFingerprint" not in dependency:
            dependency = create_predicate_dependency(dependency)
        previous_present = "previousValue" in item
        current_present = "currentValue" in item
        if not previous_present and not current_present:
            return {"evaluation": evaluate_predicate(item.get("value"), item.get("predicate"), value_present="value" in item)}
        previous = evaluate_predicate(item.get("previousValue"), dependency.get("predicate") if isinstance(dependency, Mapping) else None, value_present=previous_present)
        current = evaluate_predicate(item.get("currentValue"), dependency.get("predicate") if isinstance(dependency, Mapping) else None, value_present=current_present)
        return {
            "previousEvaluation": previous,
            "currentEvaluation": current,
            "change": classify_predicate_change(dependency, item.get("previousValue"), item.get("currentValue"), previous_present=previous_present, current_present=current_present),
        }
    if operation in {"receipt", "receipt_subsumption"}:
        return _decision_view(assess_receipt_subsumption(item.get("candidate"), item.get("requirement")))
    if operation in {"receipt_select", "receipt_selection"}:
        return _decision_view(select_subsuming_receipt(item.get("candidates"), item.get("requirement")))
    if operation in {"guarded", "guarded_action"}:
        return guarded_action(item)
    raise ValueError(f"unsupported premise-next operation: {operation}")


def run_vectors(vectors: Sequence[JsonObject]) -> list[dict[str, Any]]:
    return [{"id": vector["id"], "output": run_vector(vector)} for vector in vectors]


__all__ = [
    "PREDICATE_SPEC_VERSION",
    "assess_receipt_subsumption",
    "check_negative_premise",
    "classify_predicate_change",
    "create_predicate_dependency",
    "evaluate_predicate",
    "guarded_action",
    "predicate_semantic_fingerprint",
    "run_vector",
    "run_vectors",
    "select_subsuming_receipt",
]
