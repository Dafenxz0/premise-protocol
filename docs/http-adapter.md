# Generic HTTP adapter

`@premise/adapter-http` turns HTTP validators into PREMiSE observations when
the endpoint exposes a real version. The default order is:

1. `ETag` → `http.etag`;
2. `Last-Modified` → `http.last-modified`.

Revalidation sends `If-None-Match` or, only when no ETag exists,
`If-Modified-Since`. A `304` is `UNCHANGED`; a `404` is `MISSING`; a `412`
during revalidation is an explicit `PRECONDITION_FAILED`. The adapter never
creates a version from the observation time or a body hash.

Conditional writes require a strong ETag by default. Weak ETags are valid for
read revalidation but are rejected for `If-Match`. Last-Modified writes are
disabled by default because their one-second resolution is not a reliable CAS;
they require the explicit `allowLastModifiedAction` option and use
`If-Unmodified-Since`. Custom version schemes require
`allowCustomIfMatch` before they can authorize an HTTP write.

The request timeout aborts the underlying fetch and response-body read. Caller
abort and timeout are distinct typed error codes, and neither is retried. A
configured tenant header is written by the adapter after user headers, so it
cannot be overwritten by an action payload. The adapter has no shared cache;
callers must keep observations and validators tenant-scoped.

This package is a connector, not a database, retrieval layer or authentication
system. Credentials, authorization, endpoint semantics and remote atomicity
remain the application's responsibility.
