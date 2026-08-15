# Contract map

PREMiSE has more than one contract in this repository. Select one before
reasoning about a state or decision.

| Contract | Use it for | Important boundary |
| --- | --- | --- |
| premise/1 | portable normative states and decisions | UNKNOWN is not usable and maps to REJECT |
| premise/2 | public HTTP SDK and v2 runtime integration | use the API's documented status and decision fields |
| premise-guard/1 | CAS, idempotency, receipts, and guarded actions | a check without conditional commit is not a guard |
| premise-policy/1 | sharing scope, capabilities, and policy decisions | never broaden a scope implicitly |

The public package @premise/sdk is a network client for premise/2. It does not
replace the runtime, connector authorization, durable idempotency, or remote
conditional write. If a task needs a side effect, use a connector that
documents CAS or report UNSUPPORTED.
