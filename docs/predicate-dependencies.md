# Predicate dependencies

Predicate dependencies let a caller express the part of a resource that a
premise actually needs. A version change is therefore not automatically an
invalidation: `stock >= 5` remains preserved when stock changes from 100 to 99,
but is invalidated when it changes to 4.

The module evaluates a small deterministic predicate vocabulary and returns
`PRESERVED`, `INVALIDATED` or `UNKNOWN`. Missing values, malformed values,
non-finite numbers and an invalid semantic fingerprint fail closed as
`UNKNOWN`; an omitted value is supported only for `exists`. It does not infer
predicates from natural language, authorize writes, or replace an
authoritative connector.
