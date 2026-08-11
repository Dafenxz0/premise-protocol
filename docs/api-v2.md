# PREMiSE API v2: guía de integración

Esta guía explica cómo conectar una aplicación a PREMiSE sin tener que conocer
la implementación interna. PREMiSE conserva memoria con evidencias, estado de
validez y relaciones; tu aplicación sigue siendo responsable de decidir qué
hacer con el contexto recibido.

> Estado actual: la API v2 y el SDK están en `2.0.0-rc.1`. El contrato de
> integración está estabilizado para la release candidate, pero PREMiSE no se
> declara GA hasta cerrar los benchmarks externos, seguridad, despliegue y
> recuperación indicados en [`docs/v2-ga-acceptance.md`](./v2-ga-acceptance.md).

## 1. Qué necesitas

Para usar el SDK necesitas:

- Node.js `>=24.0.0 <25` o un navegador con `fetch` y `AbortController`.
- Una URL del servidor PREMiSE, por ejemplo `https://memory.example.com/`.
- Un tenant. Es el espacio aislado de datos de tu aplicación.
- Un token o una cabecera `Authorization` emitida por tu gateway.

El SDK no crea usuarios, tokens, TLS, bases de datos ni permisos. Es el cliente
HTTP: autentica la petición que le indiques y traduce las respuestas a tipos y
errores fáciles de manejar.

## 2. Instalar y crear el cliente

```bash
pnpm add @premise/sdk@2.0.0-rc.1
```

El caso más sencillo usa un token Bearer:

```ts
import { PremiseClient } from "@premise/sdk";

const premise = new PremiseClient({
  baseUrl: process.env.PREMISE_URL ?? "https://memory.example.com/",
  tenantId: process.env.PREMISE_TENANT ?? "tenant:acme",
  token: process.env.PREMISE_TOKEN,
  requireHttps: true,
  timeoutMs: 5_000,
  maxRetries: 2
});

const health = await premise.health();
console.log(health.ok ? "PREMiSE está disponible" : "PREMiSE necesita atención");
```

`token: "abc"` se convierte en `Authorization: Bearer abc`. Si ya tienes una
cabecera completa, usa `authorization` en su lugar:

```ts
const premise = new PremiseClient({
  baseUrl: "https://memory.example.com/",
  tenantId: "tenant:acme",
  authorization: async () => `Bearer ${await getShortLivedToken()}`,
  requireHttps: true
});
```

No configures `token` y `authorization` a la vez. `requireHttps: true` hace que
el cliente falle al arrancar si la URL es `http://`; para desarrollo local se
puede omitir o usar HTTP conscientemente.

Crea un cliente por tenant. El SDK envía `x-premise-tenant` en cada petición y
rechaza una escritura cuyo `record.envelope.tenantId` no coincida con él.
`subjectId` es opcional y se envía como `x-premise-subject` cuando tu gateway
necesita distinguir usuarios o servicios dentro del tenant.

## 3. Rutas disponibles

| Método del SDK | HTTP | Para qué sirve |
| --- | --- | --- |
| `health()` | `GET /health` | Comprueba disponibilidad y contadores básicos. |
| `capabilities()` | `GET /v2/capabilities` | Lee capacidades declaradas por el servidor. |
| `getMemory(id)` | `GET /v2/memories/{memoryId}` | Lee una memoria. |
| `registerMemory(record)` | `POST /v2/memories` | Registra una memoria raíz. |
| `deriveMemory(record)` | `POST /v2/memories` | Registra una memoria derivada. |
| `query(input)` | `POST /v2/query` | Busca y empaqueta contexto. Es de lectura aunque use POST. |
| `revalidate(id)` | `POST /v2/memories/{memoryId}/revalidate` | Pide comprobar la evidencia de una memoria. |
| `sourceChanged(uri, version)` | `POST /v2/source-changed` | Informa de un cambio en una fuente. |

Las rutas v2 no cambian silenciosamente de versión: las respuestas de health,
capabilities y memoria deben declarar `specVersion: "premise/2"`.

## 4. Guardar una memoria

Una memoria tiene un `envelope` v2 y un `content`. El envelope describe de dónde
sale la información y si sigue siendo utilizable; el contenido puede ser texto
o un objeto JSON de tu aplicación.

```ts
const now = new Date().toISOString();

await premise.registerMemory({
  envelope: {
    specVersion: "premise/2",
    tenantId: "tenant:acme",
    memoryId: "memory:acme:release-42",
    evidence: [{
      evidenceId: "evidence:release-42",
      sourceUri: "https://github.com/acme/app/releases/tag/v4.2.0",
      observedAt: now
    }],
    confidence: { score: null, method: "manual", assessedAt: now },
    conflicts: [],
    temporal: { asOf: now },
    validity: { status: "FRESH", checkedAt: now, policy: "MANUAL" },
    dependsOn: [],
    signatures: []
  },
  content: "La versión 4.2.0 se publicó el 10 de agosto."
}, {
  // La misma clave permite repetir esta operación sin duplicar el evento.
  idempotencyKey: "release:acme:42"
});
```

El SDK comprueba localmente que el envelope sea v2 y que el tenant coincida.
La validación completa de evidencias y firmas la hace el servidor/runtime.
Campos adicionales compatibles se conservan; no uses campos desconocidos para
cambiar la semántica del protocolo.

## 5. Consultar contexto

```ts
const result = await premise.query({
  query: "¿Qué cambió en la última release?",
  options: { limit: 5 },
  maxTokens: 800
});

for (const hit of result.hits) {
  console.log(`${hit.id} (${hit.score}): ${hit.text}`);
}

console.log("Contexto seleccionado:", result.context.selected.length);
```

`options.limit` limita los resultados de esa petición y `maxTokens` limita el
contexto que se empaqueta para el consumidor. Ambos límites son independientes.
El rango de `limit` es `0..1000`; `pageSize` admite `1..1000`.
`options.filter` y `options.filters` son nombres alternativos: no los envíes a
la vez.

El servidor de referencia todavía puede responder `501
PAGINATION_UNSUPPORTED` cuando se envía `pageToken`. Cuando el servidor ofrece
cursores, el SDK permite consumirlos sin cargar toda la respuesta de una vez:

```ts
for await (const page of premise.queryPages({ query: "incidentes", pageSize: 20 }, { maxPages: 10 })) {
  for (const hit of page.hits) processHit(hit);
}
```

`queryAll()` es una comodidad para reunir los hits de todas las páginas. Tiene
un límite defensivo de 100 páginas y falla con `PremisePaginationError` si el
servidor repite un cursor; no descarta datos silenciosamente.

## 6. Cabeceras y trazabilidad

| Cabecera | Quién la genera | Significado |
| --- | --- | --- |
| `Authorization` | `token` o `authorization` | Credencial para el gateway/servidor. |
| `x-premise-tenant` | `tenantId` | Tenant seleccionado. |
| `x-premise-subject` | `subjectId` | Usuario o servicio dentro del tenant. |
| `x-request-id` | SDK o la aplicación | Correlación de una petición y sus logs. |
| `Idempotency-Key` | SDK en cada POST | Repetición segura de una misma petición. |

El SDK genera un `x-request-id` por llamada y mantiene el mismo valor al
reintentarla. Puedes proporcionar uno propio en `RequestOptions.requestId`.
Usa caracteres ASCII visibles, con un máximo de 128 caracteres. Las claves de
idempotencia admiten hasta 256 caracteres ASCII visibles.

Puedes recoger métricas sin exponer secretos:

```ts
const premise = new PremiseClient({
  baseUrl: "https://memory.example.com/",
  tenantId: "tenant:acme",
  token: process.env.PREMISE_TOKEN,
  logger: (event) => metrics.record("premise.http", event)
});
```

Los eventos del logger no contienen cuerpos. Authorization, cookies, tokens,
API keys, secretos, contraseñas e `Idempotency-Key` se sustituyen por
`[REDACTED]`. Aun así, no guardes `error.body` ni el token en logs propios.

## 7. Timeouts, cancelación y retries

El timeout es por intento, no por toda la operación. Por defecto es 10.000 ms.
Con `maxRetries: 2`, una llamada puede tener hasta tres intentos, además del
tiempo de espera entre ellos.

```ts
const controller = new AbortController();
const pending = premise.query(
  { query: "estado del servicio" },
  { timeoutMs: 3_000, signal: controller.signal }
);

// Útil cuando el usuario cierra la pantalla o vence el presupuesto de la app.
controller.abort();

try {
  await pending;
} catch (error) {
  // Será PremiseAbortError si lo canceló la aplicación.
}
```

El SDK reintenta errores de red, timeout y por defecto los estados HTTP
`408`, `425`, `429`, `500`, `502`, `503` y `504`. Usa backoff exponencial con
250 ms iniciales, máximo de 5.000 ms y jitter del 20 %. Respeta `Retry-After`
hasta el máximo configurado.

La política se puede ajustar por cliente o por llamada:

```ts
const premise = new PremiseClient({
  baseUrl: "https://memory.example.com/",
  maxRetries: 3,
  retry: { baseDelayMs: 100, maxDelayMs: 2_000, jitter: 0.1 }
});

await premise.query({ query: "incidente" }, {
  timeoutMs: 2_000,
  maxRetries: 1,
  retry: { retryOn: [429, 503] }
});
```

Las escrituras POST reciben una clave de idempotencia y la conservan en todos
los intentos de esa llamada. No reutilices una clave propia para otro payload:
si cambia el contenido, el servidor debe responder `409 IDEMPOTENCY_CONFLICT`.
El replay tras reinicio o entre réplicas solo está garantizado si el servidor
usa un store de idempotencia duradero y compartido. Un store en memoria solo
protege mientras vive ese proceso.

`query` también usa POST, pero es una operación de lectura. Para las
mutaciones (`registerMemory`, `deriveMemory`, `revalidate` y `sourceChanged`),
activa retries únicamente frente a un servidor que implemente el contrato de
idempotencia v2. Contra un endpoint legacy que ignore `Idempotency-Key`, usa
`maxRetries: 0` para no arriesgar una escritura duplicada.

## 8. Errores que puede manejar tu aplicación

Todos los errores del SDK son `PremiseSdkError` o una subclase. Los errores
HTTP son `PremiseHttpError` y exponen:

- `status`: estado HTTP, si hubo respuesta;
- `code`: código estable del servidor o `HTTP_<status>` para un error legacy;
- `message` y `details`: explicación para la aplicación;
- `requestId`: identificador para buscar el incidente en los logs;
- `method`, `url` y `responseHeaders`: contexto técnico de la respuesta.

Los errores locales más importantes son:

| Clase | Cuándo ocurre |
| --- | --- |
| `PremiseTimeoutError` | Se agotó el timeout de un intento. |
| `PremiseAbortError` | La aplicación canceló la petición. |
| `PremiseNetworkError` | No se recibió una respuesta HTTP. |
| `PremiseDecodeError` | La respuesta no era JSON válido. |
| `PremisePaginationError` | El cursor se repitió o superó el límite. |
| `PremiseSdkError` con `INVALID_RESPONSE` | La respuesta JSON no cumple el contrato mínimo. |

Ejemplo para una aplicación sencilla:

```ts
import {
  PremiseAbortError,
  PremiseHttpError,
  PremiseTimeoutError
} from "@premise/sdk";

try {
  const memory = await premise.getMemory("memory:acme:release-42");
  render(memory.content);
} catch (error) {
  if (error instanceof PremiseHttpError && error.status === 404) {
    showMessage("No existe esa memoria.");
  } else if (error instanceof PremiseTimeoutError) {
    showMessage("PREMiSE está tardando demasiado; inténtalo de nuevo.");
  } else if (error instanceof PremiseAbortError) {
    // La cancelación de la UI no es un fallo del servidor.
  } else {
    throw error;
  }
}
```

El servidor v2 usa, entre otros, `400 INVALID_REQUEST`, `401 UNAUTHORIZED`,
`403 TENANT_FORBIDDEN`, `404 MEMORY_NOT_FOUND`, `409 IDEMPOTENCY_CONFLICT`,
`422 VALIDATION_ERROR`, `425 IDEMPOTENCY_IN_PROGRESS`, `501` para capacidades no
disponibles y `503 PERSISTENCE_BACKPRESSURE`. La aplicación debe decidir si
reintenta, pide credenciales nuevas o muestra un error al usuario; no debe
tratar todos los estados como equivalentes.

`isRetryablePremiseError(error)` permite preguntar si un timeout, error de red
o estado HTTP transitorio es reintentable con la política por defecto. La
política por llamada puede ser más restrictiva.

## 9. Versionado y compatibilidad

Hay dos versiones distintas:

1. `specVersion: "premise/2"` es la versión del contrato de datos y HTTP.
2. `@premise/sdk@2.0.0-rc.1` y `SDK_VERSION` son la versión del cliente.

El SDK sigue SemVer: las correcciones y campos opcionales pueden publicarse en
`2.0.x`; una ruta, cabecera obligatoria, tipo público o semántica incompatible
requiere otra versión mayor. La API v3 tendrá una superficie explícita; no se
activa cambiando una URL v2 en silencio.

El SDK conserva aliases existentes (`register`, `derive`,
`revalidateMemory`, `signalSourceChanged`) para facilitar migraciones. Las
respuestas pueden incluir campos adicionales, que se conservan en los objetos
devueltos. Las respuestas que no contienen los campos mínimos fallan de forma
explícita con `INVALID_RESPONSE` en lugar de llegar como datos aparentemente
válidos.

La especificación machine-readable canónica es
[`spec/ga-api/openapi.json`](../spec/ga-api/openapi.json) y sus schemas JSON
están en [`spec/ga-api/schemas`](../spec/ga-api/schemas). Esta documentación no
convierte una ejecución local en evidencia GA.

## 10. Qué no promete esta API

PREMiSE no es por sí solo una base de datos vectorial, un sistema de embeddings,
un motor universal de retrieval, un modelo de lenguaje ni una autoridad sobre
la verdad. La API registra evidencia y estado para que una integración pueda
tomar decisiones más trazables. TLS, KMS/HSM, OIDC, permisos, auditoría durable,
backups, observabilidad y disponibilidad dependen del despliegue y siguen
siendo gates externos de la release candidate.

## 11. Verificación local

Desde la raíz del repositorio:

```bash
pnpm --filter @premise/sdk build
pnpm --filter @premise/sdk test
```

Los tests comprueban el contrato contra un servidor HTTP controlado: headers,
tenant, autenticación Bearer, idempotencia, retries, `Retry-After`, timeout,
cancelación, errores tipados, validación de respuestas, paginación y redacción
de logs. No sustituyen las campañas externas de Postgres, carga, seguridad,
coste, rollback y holdout ciego requeridas antes de etiquetar `v2.0.0` GA.
