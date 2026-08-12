from __future__ import annotations

import json
import sys
from pathlib import Path

from evolution import run_vectors


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python reference/python/cli-evolution.py <manifest.json>")
    path = Path(sys.argv[1])
    manifest = json.loads(path.read_text(encoding="utf-8"))
    vectors = [json.loads((path.parent / (entry if isinstance(entry, str) else entry["file"])).read_text(encoding="utf-8")) for entry in manifest["vectors"]]
    print(json.dumps(run_vectors(vectors, manifest.get("profile", manifest.get("protocol", manifest.get("specVersion")))), sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
