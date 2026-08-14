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

## Leases de validación distribuidas

`PostgresValidationLeaseStore` es la primera implementación durable del contrato
de leases de PREMiSE. Usa una operación `INSERT ... ON CONFLICT` atómica, token
de fencing monotónico, contexto de tenant por transacción y RLS forzado. La API
es asíncrona porque cruza una frontera de red y devuelve las mismas decisiones
(`ACQUIRED`, `HELD`, `UPDATED`, `RELEASED`, `VALID` o `REJECTED`) que el contrato
de `@premise/runtime-core`.

```ts
import { PostgresValidationLeaseStore } from "@premise/store-postgres";

const leases = new PostgresValidationLeaseStore(adapter, {
  tableName: "premise_validation_leases"
});
await leases.initialize();
const result = await leases.acquire({
  tenantId: "tenant:acme",
  resourceId: "github:org/repo#main",
  owner: "agent:one",
  leaseId: "run:123",
  expiresAt: Date.now() + 30_000
}, Date.now());
```

El adaptador requiere que `transaction` fije todas las queries al mismo
cliente cuando se usa un pool. La operación no comparte leases entre tenants,
y la renovación, liberación y validación comparan owner, lease id y fencing
token. La prueba real se ejecuta solo con `POSTGRES_URL` y el driver `pg`; sin
esas credenciales queda explícitamente como `skipped`.

`transaction` debe fijar todas las queries en el mismo cliente. Es importante con `Pool`: el fallback `BEGIN`/`COMMIT` del paquete solo es correcto cuando el `query` inyectado ya representa una sesión fijada, no un pool que elige una conexión distinta por llamada.

## Vuelos de validación distribuidos

`PostgresValidationFlightStore` coordina una validación completa para un mismo
scope entre procesos. El primer proceso obtiene `LEADER`, los demás reciben
`FOLLOWER`, y una finalización válida guarda un recibo que los siguientes
participantes pueden reutilizar como `COMPLETED`. Si el lease caduca, el
takeover incrementa el fencing token; el líder antiguo no puede completar la
operación después de perderlo.

El scope incluye tenant, recurso, versión, autorización, política, consulta y
frontier causal. Su digest es la clave única de la fila, por lo que no se
comparten resultados entre scopes distintos. La tabla usa RLS forzado y cada
transacción fija el contexto del tenant.

```ts
import { PostgresValidationFlightStore } from "@premise/store-postgres";

const flights = new PostgresValidationFlightStore(adapter, {
  tableName: "premise_validation_flights"
});
await flights.initialize();

const claim = await flights.claim(scope, "worker:one", "flight:123", Date.now());
if (claim.kind === "LEADER") {
  const receipt = await validateOnce(scope);
  await flights.complete(scope, "worker:one", "flight:123", claim.fencingToken, receipt, Date.now());
}
```

La API es asíncrona y requiere el mismo adaptador transaccional fijado que las
leases. El adaptador implementa la coordinación durable y el fencing; todavía
no constituye por sí solo una prueba de capacidad de producción a gran escala.

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
- `loadIncrementally({ batchSize, onRecord, onEvent })` recorre records y eventos por páginas keyset dentro de una vista `REPEATABLE READ READ ONLY`; es la ruta de hidratación de arranque y no construye ni persiste un `RuntimeSnapshot` monolítico. La indexación completa de la API sigue siendo un coste separado.
- `replay(handler, { consumerId, batchSize })` bloquea el checkpoint del consumidor. El cursor solo avanza después de que el handler termina; si falla, la transacción hace rollback y el lote se puede reintentar. Usa consumidores distintos para replay paralelo independiente.

## Búsqueda lexical a escala

`PostgresRuntimeStore.search()` usa el índice FTS persistido en PostgreSQL y exige un `tenantId` exacto. Para evitar que una consulta muy común ordene millones de filas dentro de la transacción, primero materializa una ventana acotada de candidatos y solo después calcula `ts_rank_cd`.

- Por defecto, la ventana es `max(100, limit * 10)` candidatos.
- `candidateLimit` permite ajustar el compromiso entre recall y latencia; debe ser al menos `limit` y no supera 10.000.
- La ventana es una optimización aproximada: no promete el top global exacto cuando hay más coincidencias que candidatos. Mídela con el corpus y el SLA objetivo antes de elevarla a una promesa de producto.
- El adapter no ofrece embeddings ni búsqueda vectorial; `vectorWeight` distinto de cero falla de forma explícita.

## Despliegue y checks

```bash
pnpm --filter @premise/store-postgres build
pnpm --filter @premise/store-postgres test
```

El test opcional `test/postgres.integration.test.mjs` imprime explícitamente `skipped` y termina correctamente cuando `POSTGRES_URL` no está definida o `pg` no está instalado. No se requieren credenciales para CI por defecto.

La API histórica `PostgresPersistentStore` se conserva para envelopes v1; también usa el driver inyectable y transacciones para snapshots, idempotencia y migración. Para PREMiSE v2 usa `PostgresRuntimeStore`.
