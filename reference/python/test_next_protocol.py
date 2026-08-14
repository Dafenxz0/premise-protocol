from __future__ import annotations

import json
import unittest
from pathlib import Path

try:
    from .next_protocol import (
        assess_receipt_subsumption,
        check_negative_premise,
        classify_predicate_change,
        create_predicate_dependency,
        guarded_action,
        run_vector,
    )
except ImportError:  # unittest discover with ``-s reference/python``
    from next_protocol import (
        assess_receipt_subsumption,
        check_negative_premise,
        classify_predicate_change,
        create_predicate_dependency,
        guarded_action,
        run_vector,
    )


ROOT = Path(__file__).parents[2]
VECTOR_ROOT = ROOT / "spec" / "premise-next" / "vectors"


class PremiseNextReferenceTests(unittest.TestCase):
    def test_all_portable_vectors_match_their_expected_decision(self) -> None:
        manifest = json.loads((VECTOR_ROOT / "manifest.json").read_text(encoding="utf-8"))
        names = manifest["vectors"]
        self.assertEqual(len(names), len(set(names)))
        for name in names:
            vector = json.loads((VECTOR_ROOT / name).read_text(encoding="utf-8"))
            self.assertEqual(run_vector(vector), vector["expected"], vector["id"])

    def test_predicate_reference_generates_and_checks_its_own_semantic_digest(self) -> None:
        dependency = create_predicate_dependency(
            {
                "tenantId": "tenant:a",
                "resourceId": "stock",
                "incarnationId": "inc:1",
                "aspect": "available",
                "predicate": {"operator": "gte", "value": 5},
            }
        )
        self.assertEqual(classify_predicate_change(dependency, 10, 9), "PRESERVED")
        tampered = {**dependency, "semanticFingerprint": "sha256:tampered"}
        self.assertEqual(classify_predicate_change(tampered, 10, 9), "UNKNOWN")

    def test_negative_and_guarded_paths_fail_closed(self) -> None:
        self.assertEqual(
            check_negative_premise(None, {}, "2026-01-01T00:00:00Z"),
            {"state": "UNKNOWN", "decision": "REJECT", "reason": "INVALID_SCOPE"},
        )
        self.assertEqual(
            guarded_action(
                {
                    "resource": {"tenantId": "tenant:a", "resource": "resource:1"},
                    "check": {
                        "tenantId": "tenant:a",
                        "resource": "resource:1",
                        "state": "FRESH",
                        "version": {"scheme": "etag", "token": "v1"},
                    },
                    "revalidate": {
                        "tenantId": "tenant:a",
                        "resource": "resource:1",
                        "outcome": "FRESH",
                        "observedVersion": {"scheme": "etag", "token": "v1"},
                    },
                    "action": {
                        "tenantId": "tenant:a",
                        "resource": "resource:1",
                        "outcome": "APPLIED",
                    },
                    "idempotencyKey": "",
                }
            ),
            {
                "ready": True,
                "accepted": False,
                "outcome": "REJECTED",
                "expectedVersion": {"scheme": "etag", "token": "v1"},
                "reason": "IDEMPOTENCY_KEY_REQUIRED",
            },
        )

    def test_receipt_subsumption_does_not_relax_authorization_scope(self) -> None:
        scope = {
            "tenantId": "tenant:a",
            "resourceId": "resource:1",
            "incarnationId": "inc:1",
            "versionScheme": "etag",
            "versionToken": "v1",
            "validatorId": "validator:1",
            "authorizationContextDigest": "auth:a",
            "policyDigest": "policy:write",
            "changeSetDigest": None,
            "queryFamily": "resource",
            "queryParts": ["id", "status"],
            "scopes": ["/resource"],
            "causalFrontier": ["event:1"],
        }
        receipt = {
            "receiptId": "receipt:1",
            "scope": scope,
            "observedAt": "2026-01-01T00:00:00Z",
            "expiresAt": "2026-01-01T01:00:00Z",
        }
        requirement = {
            "scope": {**scope, "authorizationContextDigest": "auth:other"},
            "requiredQueryParts": ["id"],
            "requiredScopes": ["/resource"],
            "requiredFrontier": ["event:1"],
            "now": "2026-01-01T00:30:00Z",
        }
        self.assertEqual(
            assess_receipt_subsumption(receipt, requirement),
            {"eligible": False, "reason": "AUTHORIZATION_MISMATCH"},
        )


if __name__ == "__main__":
    unittest.main()
