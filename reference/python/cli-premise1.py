from __future__ import annotations

import json
import sys
from pathlib import Path

from premise1 import run_vectors


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python reference/python/cli-premise1.py <vector-file-or-manifest>")
    input_path = Path(sys.argv[1])
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    if payload.get("vectors") and all(isinstance(item, str) for item in payload["vectors"]):
        vectors = [json.loads((input_path.parent / name).read_text(encoding="utf-8")) for name in payload["vectors"]]
    else:
        vectors = payload.get("vectors", [payload])
    print(json.dumps(run_vectors(vectors), separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
