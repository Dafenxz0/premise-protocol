# Seguridad GA de PREMiSE v2

`@premise/security-core` es una base local, sin dependencias externas, para los límites criptográficos y de autorización de PREMiSE v2. Requiere Node 24 en producción, igual que el workspace.

## Garantías implementadas

- **Firmas Ed25519:** `signEd25519` firma bytes sin transformar cuando recibe texto/bytes y JSON canónico ordenado cuando recibe un valor estructurado. `verifyEd25519` usa `node:crypto`, exige una firma Ed25519 de 64 bytes y devuelve `false` para payload o firma manipulados.
- **Webhooks HMAC:** `signWebhook` y `verifyWebhookSignature` usan HMAC-SHA-256 sobre el cuerpo crudo. La comparación de candidatos se hace con `timingSafeEqual`, con padding previo para que la API de comparación no filtre longitudes. Verifica la firma antes de parsear JSON.
- **Replay:** `ReplayGuard` y `WebhookVerifier` permiten rechazar IDs y cuerpos repetidos dentro de una ventana y validar desfase de reloj. `signWebhookRequest`/`verifyWebhookRequest` incluyen `deliveryId` y timestamp en el material autenticado cuando el protocolo propio lo permite.
- **Payloads cifrados:** `encryptPayload` y `KeyRing` usan AES-256-GCM, clave de exactamente 32 bytes, IV aleatorio de 12 bytes, tag de autenticación de 16 bytes y AAD opcional. Cada envelope incluye `format`, `version`, `algorithm`, `keyId`, IV, ciphertext y tag. `KeyRing.rotate` activa una clave nueva conservando las anteriores para descifrar; `retire` las elimina de forma explícita.
- **ACL:** `AclPolicy` aplica tenant, subject, action y resource. El valor por defecto es deny, un deny explícito gana a cualquier allow y un request nunca puede usar wildcard como tenant/subject/action.
- **Auditoría:** `AuditLog.append` es append-only desde la API pública. Cada entrada contiene `previousHash` y un SHA-256 de la entrada canónica; `verifyAuditChain` detecta modificaciones y reordenaciones. `sanitizeSecrets` redacta nombres sensibles y los valores secretos entregados por el caller sin mutar el objeto original.
- **Auditoría durable local:** `FileAuditSink` persiste NDJSON canónico con `O_APPEND`, `fsync`, permisos `0600`, límites de capacidad y apertura fail-closed si la cadena está truncada, reordenada, duplicada o corrupta. Su alcance y los requisitos WORM del despliegue están documentados en [`ga-audit.md`](./ga-audit.md).

Ejemplo de aislamiento criptográfico por tenant:

```ts
const encrypted = keyRing.encrypt(payload, { associatedData: principal.tenantId });
const payload = keyRing.decrypt(encrypted, { expectedAssociatedData: principal.tenantId });
```

La AAD no es secreta, pero hace que mover el envelope a otro tenant rompa la autenticación GCM.

## Límites explícitos: no confundir con una integración KMS

Esta biblioteca no es un KMS, HSM, almacén durable ni proveedor de identidad.

En una instalación GA se requiere infraestructura adicional para:

1. Generar, custodiar, versionar, envolver y rotar las claves AES/Ed25519 con KMS/HSM. `KeyRing` mantiene material de clave en memoria del proceso; recibir una `Uint8Array` desde configuración no convierte el proceso en un KMS. No persistas claves sin envoltura ni las escribas en logs.
2. Resolver las claves por `keyId` desde KMS antes de construir el `KeyRing`, aplicar permisos mínimos por servicio/tenant y retirar versiones conforme a la política de retención. El adaptador inyectable y sus límites están documentados en [`ga-kms.md`](./ga-kms.md); el paquete no contiene un cliente KMS concreto para no imponer un proveedor.
3. Sustituir `MemoryReplayStore` por un almacén compartido con operación atómica tipo `SETNX`/insert-if-absent y TTL cuando existan varias réplicas. El guard por defecto sólo protege un proceso.
4. Persistir el audit log en una transacción append-only con almacenamiento durable/WORM, control de acceso separado y copias de seguridad. El hash chaining detecta corrupción y borrado/reordenación al verificar la cadena, pero no impide que un operador con permisos de almacenamiento borre el único archivo.
5. Distribuir y revisar las reglas ACL desde un origen de configuración controlado. Un wildcard global es deliberado y debe tratarse como una excepción revisada; el default deny permanece recomendado.

Por tanto, el paquete sí cubre las primitivas, la validación, el aislamiento lógico y la detección de tampering en proceso. La custodia de claves, la identidad de subjects, la deduplicación entre réplicas y la durabilidad del log siguen siendo responsabilidades del despliegue.

## Verificación

Desde la raíz del repositorio:

```text
pnpm --filter @premise/security-core test
pnpm --filter @premise/security-core build
node scripts/verify-security.mjs
```

La suite determinista cubre tampering de firmas, cuerpo HMAC y ciphertext; replay y ventana temporal; rotación y retiro de claves; AAD; aislamiento ACL; integridad de la cadena y redacción de secretos. El comando de verificación repite el camino crítico con la API compilada.
