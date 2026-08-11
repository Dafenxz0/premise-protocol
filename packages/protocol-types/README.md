# @premise/protocol-types

The v2 crypto helpers use detached Ed25519 signatures without adding a
runtime dependency. `canonicalizeMemoryEnvelopeV2(envelope)` returns the
unsigned envelope payload for inspection. To create a signature, use
`canonicalizeMemoryEnvelopeV2Signature(envelope, metadata)`: it binds the
envelope, domain, and every declaration field except `value` (`signedAt`,
`signerId`, `keyId`, `signatureId` and optional `evidenceId`). Store the standard
base64 signature in `DeclaredSignature.value` and verify by `keyId`:

```ts
const verified = parseAndVerifyMemoryEnvelopeV2(envelope, {
  keys: new Map([["key:1", publicKey]]),
  replayStore: new MemoryV2SignatureReplayStore()
});
```

Only `ed25519` is accepted. Verification rejects unsigned envelopes, malformed
or non-64-byte signatures, unknown/non-Ed25519 keys, metadata or payload
tampering, and replayed signatures. The default replay store is process-local
and bounded; inject the asynchronous `V2SignatureReplayStoreAsync` backed by an
atomic durable store for multiple workers or replicas.
