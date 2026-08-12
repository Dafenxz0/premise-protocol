from __future__ import annotations

import json
import unittest
from pathlib import Path

from evolution import run_vectors


class EvolutionReferenceTests(unittest.TestCase):
    def test_all_evolution_profiles_match_authored_vectors(self) -> None:
        root = Path(__file__).parents[2] / "spec"
        profiles = (
            ("premise-1.1", "manifest.json", "premise/1.1"),
            ("premise-guard-1", "manifest.json", "premise-guard/1-rich"),
            ("premise-policy-1", "manifest.json", "premise-policy/1"),
            ("premise-policy-1", "supplemental-manifest.json", "premise-policy/1-supplemental"),
        )
        for directory, manifest_name, profile in profiles:
            vector_root = root / directory / "vectors"
            manifest = json.loads((vector_root / manifest_name).read_text(encoding="utf-8"))
            vectors = [json.loads((vector_root / entry["file"]).read_text(encoding="utf-8")) if isinstance(entry, dict) else json.loads((vector_root / entry).read_text(encoding="utf-8")) for entry in manifest["vectors"]]
            actual = run_vectors(vectors, profile)
            expected = []
            for vector in vectors:
                if profile == "premise-guard/1-rich":
                    output = {"steps": [{"id": step["id"], "output": step["expect"]} for step in vector["steps"]]}
                elif profile == "premise-policy/1-supplemental" and vector.get("operation") == "guardedWrite":
                    output = {case["id"]: case["expected"] for case in vector["cases"]}
                else:
                    output = vector["expected"]
                expected.append({"id": vector.get("id", vector.get("vectorId")), "output": output})
            self.assertEqual(actual, expected, profile)


if __name__ == "__main__":
    unittest.main()
