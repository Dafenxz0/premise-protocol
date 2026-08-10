# Verificación de firmas en el runtime v2

`@premise/runtime-core` puede verificar firmas Ed25519 antes de aceptar un
registro, una derivación, un reemplazo o un restore.

```ts
const runtime = new PremiseRuntime({
  store: durableStore,
  tenantId: "tenant:acme",
  signatureVerification: {
    keys: await keyProvider.publicKeys(),
    replayStore: durableReplayStore
  }
});
```

La aplicación debe inyectar una fuente de claves externa y, cuando existen
varias réplicas, un `V2SignatureReplayStore` atómico y durable. PREMiSE no
convierte una key local en un KMS ni afirma que el modo en memoria sea válido
para alta disponibilidad.

Si se configura `signatureVerification`, los envelopes sin firma, alterados,
con clave desconocida o repetidos se rechazan. `requireSignedEnvelopes: true`
exige además una fuente de claves al arrancar y falla cerrado si falta.
