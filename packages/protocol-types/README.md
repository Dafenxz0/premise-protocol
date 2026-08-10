# @premise/protocol-types

The v2 crypto helpers use detached Ed25519 signatures without adding a
runtime dependency. `canonicalizeMemoryEnvelopeV2(envelope)` returns stable
JSON with recursively sorted object keys and without `signatures`. Sign that
UTF-8 string, store the standard base64 signature in `DeclaredSignature.value`,
and verify by `keyId`:

```ts
const verified = parseAndVerifyMemoryEnvelopeV2(envelope, {
  keys: new Map([["key:1", publicKey]]),
  replayStore: new MemoryV2SignatureReplayStore()
});
```

Only `ed25519` is accepted. Verification rejects unsigned envelopes, malformed
or non-64-byte signatures, unknown/non-Ed25519 keys, tampering, and replayed
signatures. The default replay store is process-local and bounded; inject an
atomic durable `V2SignatureReplayStore` for multiple workers or replicas.
