# Public API notes

The client speaks the `premise/2` HTTP API. The useful first call for an
application is `await client.health()`. A read-only context lookup uses
`await client.query({ query, options: { limit: 5 } })`.

The client turns failed HTTP responses into typed SDK errors and keeps tenant
configuration on each request. The SDK is a network client, not a database,
vector index, embedding service, or replacement for a source system. The
application remains responsible for authorization and for any conditional
side effect required by its connector.
