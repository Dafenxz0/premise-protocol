# Security policy

PREMiSE sits on an action boundary. A bug can cause an agent to act on a source
that changed, so security reports are treated as high priority.

## Reporting a vulnerability

Please use [GitHub's private security advisory form](https://github.com/Dafenxz0/premise-protocol/security/advisories/new)
instead of opening a public issue. Include:

- the affected commit or package;
- a minimal reproduction, preferably without credentials;
- the source identity, version and tenant shape involved;
- the observed result and the result that should have been returned;
- any workaround and the severity you believe applies.

Do not include access tokens, private repository data, database URLs or customer
information in a report. If private reporting is unavailable, open an issue with
only the words `security report requested` and wait for a private channel.

## Security boundary

PREMiSE is not an authorization provider and does not decide whether a source is
true. The source connector remains responsible for credentials, permissions and
the atomic mutation. PREMiSE is responsible for carrying evidence and versions
through a guarded decision boundary.

The main properties we test are:

- a stale or unknown premise cannot silently reach a conditional action;
- tenants, authorization contexts and validation scopes are not shared incorrectly;
- replay keys do not authorize a different action;
- a connector without an atomic action capability fails closed;
- generated-agent and standalone-plugin processes do not inherit scrubbed secrets;
- recovery and fencing paths do not accept superseded work.

## Known limits

- A read-only adapter cannot make writes safe.
- PREMiSE cannot judge the semantic correctness of an agent's plan.
- Local self-tests do not prove PostgreSQL, GitHub or provider availability.
- The current candidate is not a universal production-security certification.
- The candidate is distributed under Apache-2.0; every release still requires
  the release-specific dependency/SBOM review and the documented adoption gates
  before broad distribution.

## Release hygiene

Before a release, maintainers should run the repository's Node 24 CI, conformance,
adoption, isolation, connector and recovery gates. Results that require external
credentials or services must be labelled `NOT_RUN` when those prerequisites are
absent.
