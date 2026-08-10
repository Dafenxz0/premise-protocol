# `@premise/store-sqlite`

Store persistente local de metadata PREMiSE para SQLite. Reutiliza `@premise/index-sqlite` para la migración y las operaciones de envelopes, dependencias y eventos; añade únicamente tablas propias para snapshots e idempotencia.

El paquete también conserva `SqliteRuntimeStore`, el adapter v2 local para `RuntimeStore`. La API v1 descrita abajo es el store de envelopes/eventos; la API v2 añade records con contenido y snapshots completos para el runtime.

## Uso

```ts
import { openSqliteStore } from "@premise/store-sqlite";

const store = openSqliteStore("./var/premise.sqlite");
store.saveEnvelope(envelope);
store.appendEvent(event);
store.saveSnapshot({ memoryId: envelope.memoryId, sequence: 1, state: { status: "FRESH" } });
```

El store es síncrono porque reutiliza `DatabaseSync` y el sidecar local existente. Sus métodos son compatibles con la interfaz `PersistentStore` mediante `StoreResult<T>`: un consumidor común puede usar `await` tanto con SQLite como con PostgreSQL.

## Despliegue

1. Ejecuta Node.js 24 o posterior con `node:sqlite` disponible.
2. Mantén el archivo SQLite en un volumen persistente y con permisos de lectura/escritura para el proceso.
3. Abre el store una vez por proceso; llama a `close()` durante el apagado.
4. La migración de `@premise/index-sqlite` y la de `premise_store_*` se ejecutan al abrir el archivo. Si el esquema contiene una versión futura, el arranque se detiene para evitar pérdida de datos.

No se guarda el contenido de las memorias. Los eventos siguen siendo append-only y `event_id` es único. El snapshot de cada `memoryId` solo avanza a un `sequence` igual o mayor. La primera respuesta para una clave de idempotencia se conserva; un `requestHash` diferente se rechaza como conflicto.

El adapter v2 mantiene su propio esquema `premise_v2_*` y expone `snapshot(capturedAt)` y `restore(snapshot)`. Ambos esquemas pueden coexistir en el mismo archivo sin compartir tablas.

```bash
pnpm --filter @premise/store-sqlite build
pnpm --filter @premise/store-sqlite test
```
