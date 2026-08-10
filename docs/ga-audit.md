# Auditoría durable de PREMiSE v2

`packages/security-core/src/audit-sink.ts` define el contrato `AuditEntrySink` y una implementación local para Node: `FileAuditSink`.

## Qué garantiza

- Escribe una entrada por línea en NDJSON canónico: claves ordenadas, sin espacios y con un salto de línea final.
- Abre el archivo con `O_APPEND`; nunca sobrescribe una posición existente.
- Usa permisos `0600` y rechaza rutas que sean enlaces simbólicos o directorios.
- Hace `fsync` después de cada `append` y también en `flush`/`close`.
- Valida al abrir la secuencia, `previousHash`, hash SHA-256, IDs repetidos, orden, tamaño y final de línea. Un archivo truncado, reordenado, duplicado, no canónico o corrupto se rechaza de forma fail-closed.
- Rechaza nombres de campos sensibles y valores configurados como secretos. Las excepciones no incluyen ni imprimen el payload.
- Permite límites de entrada, tamaño total y número de registros. Al alcanzar un límite rechaza la escritura; no borra ni rota datos antiguos automáticamente.

Ejemplo:

```ts
const sink = await FileAuditSink.open("/var/lib/premise/audit.ndjson", {
  maxEntryBytes: 256 * 1024,
  maxFileBytes: 1024 * 1024 * 1024,
  maxEntries: 1_000_000,
  secretValues: [process.env.WEBHOOK_SECRET]
});

await sink.append(entry);
await sink.flush();
const entries = await sink.read();
await sink.close();
```

El constructor también valida y abre sincrónicamente para que un despliegue no pueda empezar con una cadena inválida; `FileAuditSink.open` es la forma asíncrona recomendada para construirlo.

## Límites que siguen siendo del despliegue

Este sink detecta modificaciones y hace durable el archivo mediante `fsync`, pero no se anuncia como WORM. Un operador con permisos sobre el host todavía puede borrar, sustituir o impedir el acceso al archivo. Una instalación GA debe aportar, por separado:

- almacenamiento WORM o equivalente aprobado;
- backup independiente, cifrado y probado con restauración;
- IAM y separación de permisos entre el servicio, operadores y lectores;
- retención legal, rotación de segmentos y borrado conforme a la política aplicable;
- monitorización de errores de `append`/`fsync`, espacio disponible y reintentos de backup.

Los límites `maxEntries` y `maxFileBytes` son protecciones de capacidad, no una política legal de retención. Cuando se alcanzan, la escritura falla para evitar perder evidencia silenciosamente.

## Verificación local

```text
pnpm --filter @premise/security-core build
node packages/security-core/test/audit-sink.test.mjs
```

Las pruebas usan exclusivamente directorios temporales deterministas y cubren reapertura válida, NDJSON canónico, permisos, truncado, reordenación, duplicados, secretos, límites y uso después de `close`.
