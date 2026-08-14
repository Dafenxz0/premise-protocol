# Negative premises

`NegativePremiseStore` is an opt-in bounded primitive for claims such as “no
conflict exists” or “no reservation is present”. An `ABSENT` observation is
usable only inside its tenant, resource incarnation, query and causal frontier.

The store never treats a missing or evicted entry as proof of absence. `check`
requires an authoritative observation (`entityPresent`, `frontierDigest` or
`incarnationId`); an omitted or malformed observation is `UNKNOWN`. A source
appearance, frontier change, incarnation change or expiry returns `STALE` or
`UNKNOWN`, so the caller must revalidate before acting. An appearance clears
all cached absences for the tenant/resource, including older incarnations, to
avoid an A -> B -> A resurrection.

This is a local bounded store, not a distributed absence index and not proof
that a source has been queried completely.
