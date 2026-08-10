# Integración con PREMiSE v2

@premise/sdk es el cliente TypeScript estable para la API HTTP v2. No instala
un servidor ni una base de datos: solo necesita un endpoint PREMiSE y el
fetch disponible en Node 24+ o en el navegador.

## Quickstart

Instala el paquete en la aplicación que hará las peticiones:

~~~bash
pnpm add @premise/sdk
~~~

Crea un cliente por tenant. El SDK añadirá el header
x-premise-tenant a todas las peticiones y, si se configura, también
x-premise-subject y Authorization.

~~~ts
import { PremiseClient } from "@premise/sdk";

const token = process.env.PREMISE_TOKEN;
const premise = new PremiseClient({
  baseUrl: "http://127.0.0.1:3000/",
  tenantId: "tenant:acme",
  ...(token === undefined ? {} : { token }),
  timeoutMs: 5_000,
  maxRetries: 2
});

const capabilities = await premise.capabilities();
console.log(capabilities.capabilities);

const result = await premise.query({
  query: "información sobre PREMiSE",
  options: { limit: 5 },
  maxTokens: 400
});

for (const hit of result.hits) {
  console.log(hit.id, hit.score, hit.text);
}
~~~

El servidor limita `options.limit` y `pageSize` a 1.000 resultados por petición
para evitar que una consulta sin límite agote memoria o latencia; el presupuesto
de contexto (`maxTokens`) sigue controlando cuánto se selecciona finalmente.
El límite de body predeterminado es 1 MiB y puede reducirse o ampliarse al
crear el servidor. `Idempotency-Key` admite 1-256 caracteres ASCII visibles y
`x-request-id`, 1-128.

token: "abc" se envía como Authorization: Bearer abc. Si el servidor
necesita una cabecera completa, usa authorization: "Basic ..." en lugar de
token. El tenant no se infiere de la URL: configúralo explícitamente para
evitar mezclar datos.

## Qué queda fuera del SDK

El SDK solo coloca el token o la cabecera `Authorization`; no implementa
autenticación empresarial, emisión/rotación de credenciales ni autorización
de negocio. Conecta el endpoint a tu gateway o callback de autorización.
El servidor de referencia expone HTTP plano: TLS debe terminar en un proxy,
load balancer o servidor HTTPS gestionado por tu infraestructura. KMS,
cifrado de datos, rotación de claves y sus permisos también requieren una
infraestructura externa; las `signatures` v2 son declaraciones y no prueban
criptografía por sí solas.

## Operaciones disponibles

| Método del cliente | Ruta HTTP | Resultado |
| --- | --- | --- |
| health() | GET /health | Estado del servidor |
| capabilities() | GET /v2/capabilities | Capacidades declaradas |
| getMemory(id) | GET /v2/memories/:id | MemoryRecord<T> |
| registerMemory(record) / register(record) | POST /v2/memories | Registro |
| deriveMemory(record) / derive(record) | POST /v2/memories con derived: true | Derivación |
| query(input) | POST /v2/query | Hits y contexto seleccionado |
| revalidate(id) | POST /v2/memories/:id/revalidate | Informe de validación |
| sourceChanged(sourceUri, version) | POST /v2/source-changed | IDs afectados |

Los IDs de memoria se codifican como segmentos de URL. Por ejemplo,
memory:acme:1 se puede pasar directamente a getMemory.

Para registrar una memoria, el objeto tiene la forma { envelope, content }
del contrato v2:

~~~ts
await premise.registerMemory({
  envelope: {
    specVersion: "premise/2",
    tenantId: "tenant:acme",
    memoryId: "memory:acme:1",
    evidence: [{
      evidenceId: "evidence:1",
      sourceUri: "file:///notes.txt",
      observedAt: "2026-08-10T10:00:00Z"
    }],
    confidence: { score: null, method: "manual", assessedAt: "2026-08-10T10:00:00Z" },
    conflicts: [],
    temporal: { asOf: "2026-08-10T10:00:00Z" },
    validity: { status: "FRESH", checkedAt: "2026-08-10T10:00:00Z", policy: "MANUAL" },
    dependsOn: [],
    signatures: []
  },
  content: "Texto de la memoria"
});
~~~

El SDK comprueba que record.envelope.tenantId coincida con el tenant del
cliente antes de enviar una escritura.

## Timeouts, retries e idempotencia

Cada petición tiene un timeout por intento; el valor predeterminado es 10
segundos. Se puede cancelar una petición con AbortController:

~~~ts
const controller = new AbortController();
const request = premise.query({ query: "estado actual" }, { signal: controller.signal });
controller.abort();
await request; // lanza PremiseAbortError
~~~

El SDK reintenta únicamente errores transitorios: red, timeout y HTTP 408,
425, 429, 500, 502, 503 o 504. GET y HEAD son seguros por naturaleza.
Las peticiones POST reciben automáticamente una cabecera
`Idempotency-Key`, que se conserva en todos sus intentos; así se pueden
habilitar retries sin cambiar la clave entre intentos. Las mutaciones solo
deben reintentarse contra un servidor v2 que implemente este contrato; si el
endpoint legacy ignora la cabecera, usa `maxRetries: 0` para escrituras.
Se puede fijar una clave propia cuando una operación debe ser repetible desde
la aplicación:

~~~ts
await premise.sourceChanged(
  "https://example.test/source",
  { scheme: "git.commit", token: "abc123" },
  { idempotencyKey: "source-change:example:abc123" }
);
~~~

No reutilices una clave propia para payloads distintos. El servidor v2 propaga
`Idempotency-Key` a los eventos de registro, derivación, reemplazo,
revalidación y `source-changed`: una repetición con el mismo payload devuelve
el resultado de la operación sin crear otro evento; si cambia el payload,
responde `409 IDEMPOTENCY_CONFLICT`. Para que este contrato sobreviva a un
reinicio o a varias réplicas, el runtime debe usar un store duradero y
compartido, como el adapter PostgreSQL; el store en memoria solo garantiza
replay durante la vida del proceso. El digest HTTP se calcula con el protocolo
`premise-http-idempotency/1` y el prefijo `sha256:http-v1:`; el digest de los
eventos v2 usa el namespace `sha256:v2:`. No mezcles ambos namespaces durante
una migración y trata eventos legacy sin namespace como datos históricos.

En el despliegue PostgreSQL, las respuestas completadas de idempotencia se
conservan siete días por defecto y se limpian en lotes cada hora. Se puede
ajustar con `PREMISE_HTTP_IDEMPOTENCY_RETENTION_MS`; una vez vencida la
retención, una clave antigua ya no garantiza replay y debe tratarse como una
nueva operación. Las claims abandonadas también se depuran después de dos
leases para evitar crecimiento indefinido.

Retry-After se respeta para respuestas 429/5xx hasta el límite configurado.
Se puede ajustar la política con maxRetries, retry: { baseDelayMs,
maxDelayMs, jitter, retryOn } o las mismas opciones por petición.

## Paginación

El servidor de referencia devuelve una sola respuesta de query y no incluye
`nextPageToken`; en ese caso `query()` y `queryAll()` terminan en la primera
página. Acepta `pageSize` hasta 1.000 para limitar esa respuesta, pero rechaza
`pageToken` con `501 PAGINATION_UNSUPPORTED` hasta que exista un cursor estable.
El contrato reserva `pageSize`, `pageToken` y `nextPageToken` para servidores
que paginen:

~~~ts
const hits = await premise.queryAll(
  { query: "release", pageSize: 20 },
  { maxPages: 10 }
);
~~~

queryPages() es un AsyncGenerator para consumir cada respuesta. El SDK
envía el pageToken que recibe, detecta tokens repetidos y falla con
PremisePaginationError si se supera maxPages; no descarta silenciosamente
datos.

## Contrato de errores

Todas las fallas HTTP se convierten en PremiseHttpError. El error expone
status, code, message, details, body, requestId, method, url y las cabeceras
de respuesta. Soporta tanto el error estructurado
{ "error": { "code": "...", "message": "...", "details": [] } } como el
formato compatible actual { "error": "memory not found" }; en el segundo caso
code será HTTP_<status>. El servidor de referencia también puede devolver
`{ "error": "INVALID_REQUEST", "message": "...", "requestId": "..." }`;
el SDK conserva ese código y sus `details`.

~~~ts
import {
  PremiseAbortError,
  PremiseHttpError,
  PremiseTimeoutError
} from "@premise/sdk";

try {
  await premise.getMemory("memory:missing");
} catch (error) {
  if (error instanceof PremiseHttpError) {
    console.error(error.status, error.code, error.requestId);
  } else if (error instanceof PremiseTimeoutError) {
    console.error("El servidor tardó demasiado");
  } else if (error instanceof PremiseAbortError) {
    console.error("La aplicación canceló la petición");
  } else {
    throw error;
  }
}
~~~

También existen PremiseNetworkError, PremiseDecodeError y
PremisePaginationError. isPremiseError(value) sirve para comprobar el tipo
sin depender de una subclase concreta.

## Logs y seguridad

El logger es opcional y recibe eventos estructurados de request, response,
retry y error:

~~~ts
const premise = new PremiseClient({
  baseUrl: "http://127.0.0.1:3000/",
  tenantId: "tenant:acme",
  logger: (event) => console.debug(event)
});
~~~

Los cuerpos no se escriben en logs. El SDK reemplaza por [REDACTED] los
valores de Authorization, cookies, API keys, tokens, secretos, contraseñas e
Idempotency-Key; también redacciona esos nombres en la query string. No
registres el token ni el error.body desde un logger propio.

Esto no sustituye controles de infraestructura: para producción configura
autenticación empresarial y autorización en un gateway o `authorize`, termina
TLS fuera de este servidor de referencia y conecta el cifrado/rotación de
claves a tu KMS. PREMiSE no crea esas piezas ni puede prometerlas desde el SDK.

## Versionado y compatibilidad

El paquete publicado parte de @premise/sdk@2.0.0 y sigue SemVer:

- cambios compatibles, correcciones y nuevos campos opcionales: versión
  2.x.y;
- cambios que rompan tipos públicos, rutas, headers o semántica: nueva versión
  mayor;
- el contrato HTTP es premise/2; una API v3 requiere una nueva superficie
  y no se activa cambiando silenciosamente la base URL.

La compatibilidad GA se verifica contra el servidor v2 actual sin tocar
packages/premise-server: se conservan /health, /v2/capabilities, /v2/memories,
/v2/query, /v2/memories/:id/revalidate y /v2/source-changed; los headers
adicionales pueden ser ignorados por servidores antiguos, pero sus retries de
mutaciones no son seguros si ese servidor no entiende `Idempotency-Key`. El
SDK valida que health y capabilities anuncien exactamente `premise/2`, y el
OpenAPI y los schemas JSON canónicos están en
[spec/ga-api/openapi.json](../spec/ga-api/openapi.json).

## Verificación local

Con Node 24+ instalado:

~~~bash
pnpm --filter @premise/sdk build
pnpm --filter @premise/sdk test
~~~

Los tests levantan un servidor HTTP falso local y cubren headers de tenant,
idempotencia, límites, retries, timeout, errores tipados, redacción, paginación
y las respuestas actuales de query, revalidate y source-changed. El ejemplo
copiable para un usuario nuevo está en
[examples/sdk-http](../examples/sdk-http/README.md).
