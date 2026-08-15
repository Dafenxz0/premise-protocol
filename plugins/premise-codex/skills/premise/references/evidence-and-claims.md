# Evidence and claims

Keep these result classes separate:

- PASS: the named test actually ran and its assertions passed.
- FAIL: the named test ran and an assertion or safety condition failed.
- NOT_RUN: credentials, infrastructure, or an explicit opt-in was absent.
- NOT_MEASURED: the test ran but the requested quantity was not instrumented.

Local fixtures and deterministic benchmarks demonstrate implementation
behavior in that fixture. They do not prove a public registry release,
third-party service correctness, production availability, or universal truth.

When reporting an integration, include the commit, package artifact hash,
connector class, read/write mode, requests, retries, failures, and whether
the source was local, external read-only, or an opt-in live service. Never
turn a skipped live connector into PASS.
