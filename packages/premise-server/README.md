# `@premise/premise-server` v2

Small HTTP server for the PREMiSE v2 runtime. The stable query endpoint is
`POST /v2/query`.

```json
{
  "query": "failing integration",
  "options": {
    "limit": 5,
    "candidateLimit": 100,
    "filter": { "project": "premise" }
  },
  "maxTokens": 4096
}
```

`query` is required and must be a non-empty string. `options.filter` and
`options.filters` are aliases; sending both is invalid. The server always adds
the authenticated tenant to the filter before calling the adapter.

| Field | Contract |
| --- | --- |
| `options.limit` | Optional safe integer from `0` to the configured `maxQueryHits` (default `1,000`). `0` returns no hits. |
| `options.candidateLimit` | Optional safe integer from the effective result limit (minimum `1`) to `10,000`. It is a bounded-candidate hint; a persistent adapter may use it for approximate ranking, while `HybridIndex` preserves exact top-k and ignores the hint after validation. |
| `options.filter` / `filters` | JSON metadata filter. They are mutually exclusive. |
| `options.lexicalWeight`, `vectorWeight` | Finite, non-negative adapter weights. An adapter may reject unsupported modes (for example, a lexical-only adapter can reject a non-zero vector weight). |
| `options.minScore` | Finite, non-negative minimum score. |
| `maxTokens` | Positive safe integer; defaults to `4,096` for context packing. |
| `pageSize` | Optional safe integer from `1` to `maxQueryHits`. If `limit` is also supplied, `limit` determines the search size. |
| `pageToken` | Not implemented yet; returns `501 PAGINATION_UNSUPPORTED`. |

The response is `{ "hits": [...], "context": {...} }`. Each hit has at least
`id`, `text`, and `score`; adapters may include `content`, `metadata`, and a
validated runtime `record`. A custom `PremiseSearchIndex` may ignore the
optional `candidateLimit` hint, so callers must treat it as a performance
control rather than a guarantee of global ranking recall.

Query validation errors are explicit and never clamped:

- `400 INVALID_QUERY_LIMIT` — `options.limit` is outside its range.
- `400 INVALID_QUERY_CANDIDATE_LIMIT` — `candidateLimit` is not a safe integer,
  is below the effective result limit, or exceeds `10,000`.
- `400 INVALID_QUERY_PAGE_SIZE` — `pageSize` is outside its range.
- `400 INVALID_REQUEST` — malformed query body or unsupported value type.
- `501 PAGINATION_UNSUPPORTED` — a `pageToken` was requested before cursor
  pagination is available.

The public TypeScript declarations export `PremiseQueryRequest`,
`PremiseQueryOptions`, `PremiseQueryError`, `PremiseQueryErrorCode`, and
`PremiseSearchIndex` for SDKs and adapters. Existing adapters remain compatible
because all new query fields are optional and the search method still accepts
the common `SearchOptions` shape.
