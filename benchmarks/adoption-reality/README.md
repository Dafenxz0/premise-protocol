# Runner de certificación real

Este directorio contiene una certificación local y autocontenida. Ejecuta
Node 24 como proceso real, crea directorios temporales reales, observa un
archivo que cambia, se borra y se recrea, y habla por HTTP con un servidor Node
que vive en un proceso hijo. El servidor se mata y se reinicia en el mismo
puerto; las acciones con una versión obsoleta o con la fuente ausente deben
rechazarse sin escribir efectos secundarios.

## Comandos

Desde la raíz del repositorio:

```text
node benchmarks/adoption-reality/runner.mjs
node --test benchmarks/adoption-reality/runner.test.mjs
```

El resultado queda en `.tmp/adoption-reality/certification.json`. El runner
solo elimina los directorios temporales que crea con los prefijos
`premise-adoption-reality-filesystem-` y `premise-adoption-reality-http-`; no
borra `.tmp` ni otros artefactos del repositorio.

Sin PostgreSQL, el informe queda en `PASS_WITH_NOT_RUN`: las comprobaciones
locales se ejecutaron, pero la comprobación opt-in de PostgreSQL permanece
`NOT_RUN`. Solo un informe `PASS` incluye todos los checks definidos.

PostgreSQL es opt-in. Sin `POSTGRES_URL`, el resultado es explícitamente
`NOT_RUN` y no se intenta conectar:

```powershell
$env:POSTGRES_URL = "postgres://usuario:clave@127.0.0.1:5432/premise"
node benchmarks/adoption-reality/runner.mjs
```

Con la variable presente se requiere el driver `pg` disponible en el entorno,
y solo se ejecutan consultas de lectura dentro de `BEGIN TRANSACTION READ
ONLY`. Una conexión configurada pero inaccesible es `FAIL`, no `NOT_RUN`.

## Límites

La campaña demuestra comportamiento de procesos, filesystem y HTTP locales;
no demuestra disponibilidad de GitHub, un registry, un despliegue productivo,
rendimiento o eficacia de un agente. La fixture HTTP es una sonda de
certificación del borde de versión, no un sustituto de CAS para todos los
conectores del SDK. El runner no modifica `packages/`, manifests, lockfiles,
CI, `.agents/` ni `plugins/`.
