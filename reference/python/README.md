# Python references

This directory contains the small, stdlib-only implementation used by the
public `premise/1` conformance gate. It is deliberately independent from the
TypeScript reference and does not import the v2 runtime.

## PREMiSE/1

```powershell
python reference/python/cli-premise1.py spec/premise-1/vectors/manifest.json
python -m unittest discover -s reference/python -p "test_premise1.py"
```

The output is deterministic JSON. It implements evidence/version checks,
dependency propagation, revalidation, idempotent replay, tenant isolation and
TOCTOU rejection without importing TypeScript or using a database/network.
