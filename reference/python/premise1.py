"""Independent, stdlib-only PREMiSE/1 reference semantics.

The repository also contains a legacy v2 Python experiment in ``premise.py``.
This module is intentionally separate so the conformance command cannot
accidentally certify the larger runtime as the minimal protocol.
"""

from __future__ import annotations

import json
from typing import Any

State = str


def decision_for(state: State) -> str:
    return "USE" if state == "FRESH" else "REVALIDATE" if state == "STALE" else "REJECT"


def result(state: State, **extra: Any) -> dict[str, Any]:
    return {"state": state, "decision": decision_for(state), **extra}


def _check_memory(vector: dict[str, Any], memory_id: str, seen: set[str]) -> dict[str, Any]:
    memories = vector.get("memories")
    if memories is None:
        memories = [vector["memory"]] if vector.get("memory") is not None else []
    memory = next((candidate for candidate in memories if candidate.get("memoryId") == memory_id), None)
    tenant = vector.get("tenant")
    if memory is None or (tenant is not None and memory.get("tenantId") != tenant):
        return result("UNKNOWN")
    if memory_id in seen:
        return result("UNKNOWN")
    if memory.get("invalidation") is not None:
        return result("INVALID")
    next_seen = set(seen)
    next_seen.add(memory_id)
    dependency_stale = False
    for dependency_id in memory.get("dependencies", []):
        dependency = _check_memory(vector, dependency_id, next_seen)
        if dependency["state"] in ("INVALID", "UNKNOWN"):
            return dependency
        if dependency["state"] == "STALE":
            dependency_stale = True
    if dependency_stale:
        return result("STALE")
    observations = vector.get("observations", {})
    for evidence in memory.get("evidence", []):
        validity = evidence.get("validity")
        if validity in ("INVALID", "UNKNOWN", "STALE"):
            return result(validity)
        observation = observations.get(evidence.get("source"))
        if observation is None or not observation.get("available", False):
            return result("UNKNOWN")
        if evidence.get("version") is None or observation.get("version") is None:
            return result("UNKNOWN")
        if evidence["version"] != observation["version"]:
            return result("STALE")
    return result("FRESH")


def _revalidation_result(value: str) -> dict[str, str]:
    if value == "UNCHANGED":
        return result("FRESH")
    if value == "UNKNOWN":
        return result("UNKNOWN")
    if value in ("CHANGED", "MISSING"):
        return result("INVALID")
    raise ValueError(f"unsupported revalidation result: {value}")


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _replay(vector: dict[str, Any]) -> dict[str, int]:
    applied: dict[str, str] = {}
    replayed = 0
    conflicts = 0
    for operation in vector.get("operations", []):
        key = operation["idempotencyKey"]
        payload = _stable_json(operation.get("payload"))
        if key not in applied:
            applied[key] = payload
        elif applied[key] == payload:
            replayed += 1
        else:
            conflicts += 1
    return {"applied": len(applied), "replayed": replayed, "conflicts": conflicts}


def run_vector(vector: dict[str, Any]) -> Any:
    operation = vector["operation"]
    if operation == "check":
        memory_id = vector.get("target") or vector.get("memory", {}).get("memoryId", "")
        return _check_memory(vector, memory_id, set())
    if operation == "revalidate":
        items = vector.get("results")
        if items is None:
            items = [{"result": vector["result"]}] if vector.get("result") is not None else []
        return [_revalidation_result(item["result"]) for item in items]
    if operation == "replay":
        return _replay(vector)
    if operation == "write":
        safe = vector.get("validatedVersion") is not None and vector.get("validatedVersion") == vector.get("writeVersion")
        return result("FRESH" if safe else "STALE", toctouEscaped=False)
    raise ValueError(f"unsupported operation: {operation}")


def run_vectors(vectors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"id": vector["id"], "output": run_vector(vector)} for vector in vectors]
