# Receipt subsumption

Receipt subsumption is an opt-in safety check for reusing a receipt produced
for a query that contains more requirements than the current query. It only
relaxes query coverage. Tenant, resource, incarnation, version, validator,
authorization, policy, causal frontier and scope must still be compatible.

The implementation is deliberately conservative and deterministic. Query and
scope capability arrays must be sorted, duplicate-free tokens; a candidate may
cover a required subset. Causal frontiers require exact equality unless a
connector supplies a stronger comparator, so opaque event IDs are never
treated as an ordering proof. Future-dated or internally inconsistent receipts,
malformed scopes and missing safety fields are rejected. A rejected candidate
is not evidence that the premise is fresh; callers must perform a new
validation. This module does not claim a formal proof for arbitrary query
languages or distributed stores.
