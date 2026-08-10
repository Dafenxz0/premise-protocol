# GA load y fiabilidad

Esta campaña mide un store sintético de metadatos, no un sistema de memoria de producción. Genera eventos reproducibles, los produce con `worker_threads`, los persiste como NDJSON mediante un writer con backpressure y los aplica a un store separado por tenant. Los resultados describen el workload, el host y la configuración concreta; no son un SLA, una promesa de capacidad ni una capacidad universal.

## Ejecutar con Node 24

No hacen falta dependencias adicionales ni el build del monorepo. Desde la raíz:

```powershell
node --version
node benchmarks/ga-load/runner.mjs --profile small
node benchmarks/ga-load/self-check.mjs
```

La campaña de CI debe ejecutarse con Node 24.x:

```powershell
nvm use 24
node benchmarks/ga-load/runner.mjs --profile ci --concurrency 4 --enforce-gates
node benchmarks/ga-load/self-check.mjs
```

`--enforce-gates` hace fallar el proceso si no es Node 24, si falla un invariante o si se incumple el gate de rendimiento de CI. El runner permite un smoke local en otra versión moderna de Node para depuración, pero ese resultado queda marcado como `smokeOnly` y no es elegible para el gate de Node 24. `results.json` se escribe en `benchmarks/ga-load/results.json` salvo que se use `--output`.

## Perfiles y controles

| Perfil | Memorias de carga | Tenants | Concurrencia | Batch | Memorias de fiabilidad |
| --- | ---: | ---: | ---: | ---: | ---: |
| `small` | 10.000 | 4 | 2 | 256 | 2.048 |
| `ci` | 100.000 | 16 | 4 | 512 | 10.000 |
| `full` | 1.000.000 | 64 | 8 | 1.024 | 50.000 |

`full` es opt-in porque el heap y el journal crecen con el host. Se puede fijar cualquier tamaño sin editar código:

```powershell
node benchmarks/ga-load/runner.mjs --profile full --memories 2000000 --tenants 128 --concurrency 8 --batch-size 2048
```

Opciones principales: `--scenario load|reliability|all`, `--seed`, `--reliability-memories`, `--max-ms`, `--output` y `--enforce-gates`. El seed por defecto es `20260810`; tenant, índice de memoria, hash sintético y orden del journal son deterministas. El orden de commits se mantiene por batch aunque las respuestas de los workers lleguen fuera de orden.

## Qué se mide

- `load.latency` publica p50, p95 y p99 de batches, desde el dispatch al worker hasta el write ordenado del journal y la aplicación en el store. No es una distribución de una petición HTTP.
- `load.throughput.memoriesPerSecond` es `memorias aplicadas / duración de carga`.
- `load.heap` mide `heapUsed` y RSS del proceso padre; el heap de los workers no está agregado.
- `load.errors` separa errores de worker, journal, store e inesperados. Una carga correcta debe aplicar exactamente todas las memorias y tener cero errores.
- `load.backpressure` cuenta retornos `false` de `stream.write`, esperas de `drain` y el máximo de batches en vuelo. El máximo debe ser menor o igual que `--concurrency`.
- `load.tenants` reconcilia el total por tenant. `load.isolation.passed` prueba una lectura propia, una lectura de otro tenant y, cuando hay más de un tenant, una lectura válida del segundo tenant.

## Escenarios de fiabilidad

Los escenarios usan un corpus menor e independiente de la carga para que la recuperación desde snapshot sea legible y no convierta el test de integridad en una segunda campaña de millones de registros.

1. `crash-restart`: deja un prefijo durable, reinicia y completa el journal; una segunda reproducción debe ser totalmente duplicada e idempotente.
2. `duplicate-events`: reproduce eventos repetidos sin mutar dos veces y rechaza una misma clave de idempotencia con digest distinto.
3. `journal-corruption-truncation`: acepta únicamente un tail incompleto explícitamente tolerado, conserva el prefijo completo y rechaza corrupción JSON en mitad del journal.
4. `snapshot-recovery`: serializa un snapshot, restaura un store nuevo y reproduce solo la cola posterior hasta recuperar el total exacto.
5. `tenant-isolation`: permite el mismo id local en dos tenants y comprueba que cada tenant solo puede leer su propio registro.

## Gates

Los gates de corrección se aplican en todos los perfiles y no dependen de una cifra de rendimiento:

- carga exacta, cero errores de worker/journal/store y cero errores inesperados;
- aislamiento por tenant y backpressure acotado por la concurrencia configurada;
- todos los escenarios de crash/restart, duplicados, corrupción/truncación, snapshot y tenant isolation aprobados.

El gate de rendimiento se evalúa solo con `--profile ci --enforce-gates` y Node 24.x, sobre el host de CI fijado para la campaña:

| Métrica | Umbral gate |
| --- | ---: |
| throughput | `>= 10.000` memorias/s |
| p99 de batch | `<= 500 ms` |
| peak `heapUsed` del padre | `<= 1.024 MiB` (1 GiB) |

Estos umbrales son una barrera de regresión para ese workload y host, no una cifra portable a otra máquina, store, payload o patrón de acceso. Si cambia el host de CI, hay que registrar una nueva baseline y revisar el gate junto con los resultados.

## Límites de interpretación

El runner no mide retrieval, red, compresión, fsync, una base de datos real, contenido externo ni recuperación ante pérdida física del disco. Cada memoria es metadata sintética con un hash; no se debe extrapolar el throughput a memorias reales. Repetir `small`, `ci` y `full` en hardware objetivo y conservar `seed`, `configuration`, versión de Node y `results.json` junto con cualquier conclusión.
