# `@premise/store-postgres`

Store persistente de metadata PREMiSE para PostgreSQL. Guarda únicamente envelopes, eventos, snapshots e información de idempotencia; el contenido de la memoria queda fuera.

El paquete también conserva `PostgresRuntimeStore`, el adapter v2 basado en `RuntimeStore`. Ambos caminos reciben un cliente por inyección; no se crea un pool ni se leen credenciales dentro del paquete.

## Driver inyectable

El paquete no depende de `pg`, no abre conexiones y no lee credenciales. Se inyecta un adaptador con `query(sql, parameters)` y, opcionalmente, `close()`:

```ts
import { Pool } from "pg";
import { openPostgresStore } from "@premise/store-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = await openPostgresStore({
  query: (sql, parameters) => pool.query(sql, parameters ? [...parameters] : [])
});
```

El adaptador puede ser un pool, un cliente transaccional o un doble en memoria. Para tests no hace falta PostgreSQL ni ninguna variable de entorno. `openPostgresStore()` aplica `POSTGRES_SCHEMA_SQL`; si la migración la gestiona el despliegue, usa `new PostgresPersistentStore(adapter, { autoMigrate: false })` y ejecuta ese SQL durante la release.

## Despliegue

1. Instala el driver PostgreSQL en la aplicación (`pg` es una opción, pero no una dependencia de este paquete).
2. Ejecuta `POSTGRES_SCHEMA_SQL` con una cuenta que pueda crear tablas e índices, o inclúyelo en tu sistema de migraciones.
3. Conecta el pool/cliente mediante el adaptador inyectable y cierra el store en el apagado de la aplicación.
4. Concede a la cuenta de runtime `SELECT`, `INSERT` y `UPDATE` sobre `premise_store_*`; no necesita permisos de migración si el esquema se despliega por separado.

Las escrituras de eventos son append-only y `event_id` es único. Los snapshots conservan el mayor `sequence` observado para cada `memoryId`. Una clave de idempotencia conserva la primera respuesta; un `requestHash` diferente se rechaza como conflicto.

Para el adapter v2, llama a `migrate()` una vez al desplegar el esquema y usa `snapshot(capturedAt)`/`restore(snapshot)` para exportar o rehidratar el estado persistido. Si el cliente implementa `transaction()`, `restore()` la utiliza para mantener records y eventos juntos.

```bash
pnpm --filter @premise/store-postgres build
pnpm --filter @premise/store-postgres test
```
