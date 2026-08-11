from __future__ import annotations

import json
import unittest
from pathlib import Path

from premise1 import run_vector


class PremiseOneReferenceTests(unittest.TestCase):
    def test_shared_vectors_match_expected_outputs(self) -> None:
        root = Path(__file__).parents[2] / "spec" / "premise-1" / "vectors"
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        for name in manifest["vectors"]:
            vector = json.loads((root / name).read_text(encoding="utf-8"))
            output = run_vector(vector)
            if vector["operation"] == "revalidate":
                expected = [{"state": item["expected"]["state"], "decision": item["expected"]["decision"]} for item in vector["results"]]
            else:
                expected = vector["expected"]
            self.assertEqual(output, expected, vector["id"])


if __name__ == "__main__":
    unittest.main()
