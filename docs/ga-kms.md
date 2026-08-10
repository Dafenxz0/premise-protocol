# Adaptador externo de claves para PREMiSE v2

`@premise/security-core` incluye una abstracción pequeña y agnóstica de proveedor para que una aplicación resuelva claves desde un KMS o HSM externo antes de construir su `KeyRing`. El paquete no contiene un cliente de AWS KMS, Google Cloud KMS, Azure Key Vault, HashiCorp Vault ni un HSM, y no hace llamadas de red por sí mismo.

Esto es un adaptador de integración, no una certificación de custodia de claves. La certificación de producción depende del proveedor real, su IAM, sus políticas de tenant, el HSM/KMS, la auditoría durable, la rotación operativa y las pruebas de staging de cada despliegue.

## Contrato

El integrador inyecta un `KeyProvider`:

```ts
interface KeyProvider {
  resolve(reference: KeyReference): Promise<KeyMaterial>;
}

interface KeyReference {
  keyId: string;
  version: string;
  algorithm: "aes-256-gcm";
  tenantId: string;
}

interface KeyMaterial extends KeyReference {
  material: Uint8Array; // exactamente 32 bytes; nunca se registra
}
```

La referencia se normaliza y valida antes de invocar al proveedor:

- `keyId`, `version` y `tenantId` deben ser textos ASCII imprimibles, no vacíos, sin espacios en los extremos y sin comodines.
- `version` es obligatoria; se conserva como identificador de versión del proveedor.
- `algorithm` debe ser exactamente `aes-256-gcm`, que es el algoritmo que consume el `KeyRing` actual.
- Todas las claves de un `KeyRing` deben pertenecer al mismo `tenantId`.
- La respuesta del proveedor debe repetir exactamente `keyId`, `version`, `algorithm` y `tenantId` solicitados, y entregar material de exactamente 32 bytes.

Una respuesta inconsistente, un provider ausente, una excepción del provider o un reloj inválido producen `SecurityError` con `CONFIGURATION_ERROR`. El error no conserva `cause`, texto del provider ni material criptográfico.

## Resolución, caché y rotación

```ts
const resolver = new ExternalKeyResolver({
  provider: kmsAdapter,
  cacheTtlMs: 300_000
});

const ring = await resolver.createKeyRing({
  tenantId: "tenant:acme",
  active: {
    tenantId: "tenant:acme",
    keyId: "payments/aes-v2",
    version: "kms-version-2",
    algorithm: "aes-256-gcm"
  },
  previous: [previousReference]
});
```

La clave de caché está ligada a `tenantId`, algoritmo, `keyId` y `version`. Las solicitudes concurrentes de la misma referencia comparten una única resolución al provider. Cuando vence el TTL no se sirve material antiguo: se resuelve de nuevo y, si falla, la operación falla cerrada.

La invalidación es explícita:

```ts
resolver.invalidate(reference); // revocación o cambio de material de esa versión
resolver.clear();               // invalidación completa
const rotatedRing = await resolver.rotateKeyRing(rotationOptions);
```

La invalidación también crea una barrera para resoluciones en curso: una respuesta que llegue después de la invalidación no se almacena ni se entrega como material válido. `cacheTtlMs: 0` deshabilita la caché; no debe usarse como configuración de rendimiento de producción sin una decisión operativa documentada.

`createKeyRing` resuelve y valida todas las referencias antes de instanciar `KeyRing`. La factory de una sola operación ofrece la misma garantía:

```ts
const ring = await createKeyRingFromProvider({
  provider: kmsAdapter,
  tenantId: "tenant:acme",
  active: activeReference,
  previous: previousReferences
});
```

El `KeyRing` actual identifica los envelopes por `keyId`, no por `keyId` y `version`. Por eso el adaptador rechaza dos referencias con el mismo `keyId` dentro del mismo ring, aunque sus versiones sean distintas. Para una rotación simultánea se deben usar identificadores de clave que sean únicos en el ring o extender primero el formato de envelope de forma compatible.

## Obligaciones del adaptador real

El adapter de cada proveedor debe, como mínimo:

1. Autorizar la resolución con identidad de servicio y política de tenant mínima; no aceptar `tenantId` del usuario sin verificarlo contra el contexto autenticado.
2. Usar APIs oficiales del KMS/HSM, TLS y controles de región/entorno requeridos por la organización.
3. Evitar logs, métricas, trazas, excepciones y mensajes de soporte que contengan material, plaintext, tokens o respuestas completas del proveedor.
4. Mantener la auditoría durable de resolución, denegación, rotación y revocación en el sistema aprobado por la organización, con retención y control de acceso.
5. Definir quién activa una versión, cuánto tiempo se conservan versiones anteriores y cómo se revoca una clave comprometida; después debe llamar a `invalidate` o `clear` según la política.
6. Probar permisos, rotación, recuperación, límites de cuota y fallos del KMS/HSM en staging aislado antes de producción.

El material termina en la memoria del proceso porque el `KeyRing` existente cifra localmente. Este módulo no promete borrado seguro de memoria de JavaScript ni convierte una aplicación en un HSM. La arquitectura debe limitar el proceso, los permisos, el acceso al heap y la exposición de diagnósticos de acuerdo con el modelo de amenaza.

## Evidencia de GA

Los tests incluidos usan únicamente providers inyectados y deterministas: no hay red, credenciales ni KMS falso. Para elevar esta integración a evidencia de producción hacen falta, fuera de este paquete:

- una prueba de staging contra el KMS/HSM elegido y sus políticas IAM reales;
- evidencia de aislamiento entre tenants y de denegación por versión/algoritmo incorrectos;
- rotación y revocación observadas con auditoría durable;
- prueba de recuperación ante indisponibilidad, timeout y rate limit del proveedor;
- revisión de retención, backups y respuesta ante compromiso de una clave;
- aprobación de seguridad y operación para el entorno concreto.

Comprobaciones deterministas del paquete:

```text
pnpm --filter @premise/security-core build
pnpm --filter @premise/security-core test
node packages/security-core/test/external-key-provider.test.mjs
```
