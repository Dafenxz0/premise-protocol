# PREMiSE `premise/1.1`: identidad y coherencia

`premise/1.1` responde a una situación sencilla: una memoria puede haber sido
correcta cuando se leyó y dejar de serlo mientras el agente sigue trabajando.

La versión separa cinco cosas que antes podían mezclarse:

| Dato | Pregunta que responde |
| --- | --- |
| `resourceId` | ¿Qué recurso observé? |
| `incarnationId` | ¿Es la misma vida del recurso o fue borrado y creado otra vez? |
| `versionToken` | ¿Qué revisión devolvió la fuente? |
| `observationId` | ¿Qué lectura concreta estoy reutilizando? |
| `scopes` | ¿Qué partes del recurso fueron realmente necesarias? |

## Ejemplo

Una memoria depende únicamente de `/head_sha` de una pull request. Si cambia
el título pero el `head_sha` permanece sin tocar, una invalidación diferencial
puede mantenerla fresca. Si cambia el commit, la memoria pasa a `STALE` y debe
revalidarse.

Si la PR se elimina y luego se crea otra con el mismo número y la misma versión
aparente, `incarnationId` evita que la observación antigua vuelva a usarse.

## Garantía y límite

La tabla sigue siendo:

```text
FRESH   → USE
STALE   → REVALIDATE
UNKNOWN → REJECT
INVALID → REJECT
```

Esta superficie decide la validez de premisas. No protege por sí sola un write
remoto; para eso existe [`premise-guard/1`](./premise-guard-1.md).
