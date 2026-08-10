# `@premise/store-postgres`

Store PostgreSQL para PREMiSE v2. El paquete no depende de `pg`, no crea pools y no lee credenciales: la aplicación inyecta `query`, `transaction` y `close`. Los tests usan dobles en memoria; el test real solo se activa si existe `POSTGRES_URL` y un driver `pg` instalable por la aplicación.

## Uso

```ts
import { Pool } from "pg";
import { PostgresRuntimeStore } from "@premise/store-postgres";

const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
const store = new PostgresRuntimeStore({
  query: (sql, values) => pool.query(sql, values ? [...values] : []),
  transaction: async (action) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action({ query: (sql, values) => client.query(sql, values ? [...values] : []) });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    } finally {
      client.release();
    }
  }
}, { tenantId: "tenant:acme" });

await store.migrate();
```

`transaction` debe fijar todas las queries en el mismo cliente. Es importante con `Pool`: el fallback `BEGIN`/`COMMIT` del paquete solo es correcto cuando el `query` inyectado ya representa una sesión fijada, no un pool que elige una conexión distinta por llamada.

## Migraciones y aislamiento

Las migraciones v2 están versionadas en [`migrations/`](./migrations):

1. tablas `records`, `events` y `snapshots`, con claves compuestas por tenant y constraints de idempotencia;
2. RLS `FORCE ROW LEVEL SECURITY` en todas las tablas de runtime;
3. checkpoints de replay por `(tenant_id, consumer_id)`.

`migrate()` ejecuta las migraciones dentro de una transacción y toma un advisory lock para que dos despliegues concurrentes no apliquen la misma versión. `POSTGRES_RUNTIME_SCHEMA_SQL` sirve para un sistema externo de migraciones.

La política RLS compara `tenant_id` con `current_setting('premise.tenant_id', true)`. Cuando se construye el store con `{ tenantId }`, cada operación abre una transacción, ejecuta `set_config('premise.tenant_id', ..., true)` y añade filtros explícitos por tenant. El rol de runtime debe tener acceso a las tablas, pero no necesita permisos DDL si la migración se ejecuta durante el release. Usa un rol de migración/owner para crear tablas y políticas.

No construyas un store v2 sin `tenantId` para tráfico normal: ese modo está pensado para tareas administrativas con un rol que pueda leer todos los tenants. Con RLS forzado, una conexión sin contexto no devuelve datos de tenant.

## Escrituras, snapshots y replay

- `appendEvent()` usa `UNIQUE (tenant_id, idempotency_key)` y compara el evento completo ante una repetición; un mismo idempotency key con otro payload falla.
- `putAndAppend()` guarda record y evento en una única transacción.
- `snapshot()` usa `REPEATABLE READ` y persiste el snapshot; `restore()` borra y repuebla records, eventos, snapshots y checkpoints de forma atómica.
- `replay(handler, { consumerId, batchSize })` bloquea el checkpoint del consumidor. El cursor solo avanza después de que el handler termina; si falla, la transacción hace rollback y el lote se puede reintentar. Usa consumidores distintos para replay paralelo independiente.

## Despliegue y checks

```bash
pnpm --filter @premise/store-postgres build
pnpm --filter @premise/store-postgres test
```

El test opcional `test/postgres.integration.test.mjs` imprime explícitamente `skipped` y termina correctamente cuando `POSTGRES_URL` no está definida o `pg` no está instalado. No se requieren credenciales para CI por defecto.

La API histórica `PostgresPersistentStore` se conserva para envelopes v1; también usa el driver inyectable y transacciones para snapshots, idempotencia y migración. Para PREMiSE v2 usa `PostgresRuntimeStore`.
