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
- La firma se calcula sobre la representación canónica sin el campo
  `signatures`; cualquier modificación de los datos invalida la firma.
- Se rechazan envolventes sin firma, `keyId` desconocidos, claves que no sean
  públicas Ed25519, firmas mal codificadas, firmas inválidas y replays.
- Si `requireSignedEnvelopes` es `true` sin una fuente de claves, el runtime
  no arranca.

La verificación criptográfica sí está cubierta por tests locales. No equivale
a custodia de claves, identidad, autorización de usuarios ni a una garantía
de auditoría durable.

## Límite del servidor HTTP incluido

`ops/server.mjs` acepta `PREMISE_SIGNATURE_KEYS_FILE` únicamente como una
fuente local de claves públicas PEM en desarrollo. Valida al arrancar que cada
entrada sea una clave pública Ed25519 y rechaza material de clave privada.

El servidor de referencia usa `MemoryV2SignatureReplayStore`, que es un guard
acotado al proceso. Por eso falla cerrado si se intenta configurar el fichero
de claves fuera de `development`: tras un reinicio o con varias réplicas ese
guard no proporciona replay protection durable y compartida. No se presenta
como KMS, HSM ni como un almacén de secretos.

Para una instalación protegida hay que construir el runtime con:

1. una fuente externa de claves públicas versionada y autorizada;
2. un `V2SignatureReplayStore` compartido, durable y atómico, por ejemplo una
   operación insert-if-absent con TTL y restricciones de tenant;
3. permisos mínimos para leer claves y reclamar un identificador de firma;
4. rotación, revocación, recuperación y monitorización operadas fuera de este
   paquete.

Hasta que esos componentes existan y se prueben en la infraestructura real,
la afirmación correcta es “verificación Ed25519 local disponible”, no
“seguridad criptográfica distribuida lista para producción”.
