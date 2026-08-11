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
  },
  requireSignedEnvelopes: true
});
```

## Qué verifica el runtime

- La envolvente completa se valida antes de verificarla.
- Solo se acepta el algoritmo Ed25519.
- La firma se calcula sobre la representación canónica de la envolvente y de
  su metadato (`signatureId`, `keyId`, `signerId`, `signedAt` y `evidenceId`);
  cualquier modificación de los datos o del contexto invalida la firma.
- Se rechazan envolventes sin firma, `keyId` desconocidos, claves que no sean
  públicas Ed25519, firmas mal codificadas, firmas inválidas y replays.
- Si `requireSignedEnvelopes` es `true` sin una fuente de claves, el runtime
  no arranca.

La verificación criptográfica sí está cubierta por tests locales. No equivale
a custodia de claves, identidad, autorización de usuarios ni a una garantía
de auditoría durable.

## Límite del servidor HTTP incluido

`ops/server.mjs` acepta `PREMISE_SIGNATURE_KEYS_FILE` como una fuente de
claves públicas PEM/JSON. Valida al arrancar que cada entrada sea una clave
pública Ed25519 y rechaza material de clave privada. Fuera de `development`
exige `PREMISE_REQUIRE_SIGNED_ENVELOPES=1`, PostgreSQL y la migración 007;
usa `PostgresSignatureReplayStore` con `claimMany` atómico, RLS y TTL.

En `development` puede usarse `MemoryV2SignatureReplayStore`, pero solo es un
guard acotado al proceso. La configuración local no se presenta como KMS, HSM,
identidad de usuario ni almacén de secretos.

Para una instalación protegida hay que construir el runtime con:

1. una fuente externa de claves públicas versionada y autorizada;
2. un `V2SignatureReplayStoreAsync` compartido, durable y atómico, por ejemplo
   una operación insert-if-absent con TTL y restricciones de tenant;
3. permisos mínimos para leer claves y reclamar un identificador de firma;
4. rotación, revocación, recuperación y monitorización operadas fuera de este
   paquete.

El adapter PostgreSQL y el mapeo HTTP de replay/indisponibilidad están
cubiertos por tests de integración y de servidor; los tests PostgreSQL se
saltan cuando no existe `POSTGRES_URL`. Esto demuestra el contrato, no una
certificación de infraestructura. Siguen fuera de este paquete la custodia
KMS/HSM, TLS/OIDC, auditoría externa, backups cifrados/WORM, rotación operada
y las pruebas multi-réplica/failover en el entorno objetivo.
