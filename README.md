# PREMiSE Protocol

<p align="center">
  <img src="assets/premise-logo.jpg" alt="Logo PREMiSE Memory Validity Protocol" width="760">
</p>

<p align="center">
  <strong>La capa de validez para la memoria de los agentes.</strong><br>
  Cuando cambia el mundo, PREMiSE ayuda a saber qué recuerdos siguen siendo utilizables.
</p>

<p align="center">
  <a href="https://github.com/Dafenxz0/premise-protocol/actions/workflows/ci.yml"><img src="https://github.com/Dafenxz0/premise-protocol/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/Dafenxz0/premise-protocol/releases/tag/v0.2.0-rc.1"><img src="https://img.shields.io/badge/release-v0.2.0--rc.1-0B132B?style=flat-square" alt="Release v0.2.0-rc.1"></a>
  <img src="https://img.shields.io/badge/Node.js-24-14B8A6?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 24">
  <img src="https://img.shields.io/badge/pnpm-10-F59E0B?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm 10">
  <img src="https://img.shields.io/badge/spec-premise%2F2-2563EB?style=flat-square" alt="PREMiSE spec 2">
</p>

> PREMiSE no sustituye a tu sistema de memoria. Guarda la procedencia, la versión, las dependencias y la vigencia de un recuerdo para que un agente no trate información antigua como si fuera actual.

## PREMiSE en una frase

Un agente puede recordar que “la pull request #42 se puede fusionar”. Después puede llegar un commit nuevo, fallar una comprobación o desaparecer la fuente original. PREMiSE registra ese cambio, lo propaga a los recuerdos derivados y devuelve una decisión clara:

| Estado | Significado para una aplicación |
| --- | --- |
| `FRESH` | La evidencia coincide con la versión observada y el recuerdo se puede usar. |
| `STALE` | Algo puede haber cambiado; hay que comprobarlo otra vez. |
| `INVALID` | La evidencia demuestra que ya no sirve como soporte actual. |
| `UNKNOWN` | No hay información suficiente para decidir con seguridad. |

Invalidar una memoria no la borra: el contenido y la historia siguen perteneciendo al sistema que la almacena.

## Qué aporta la v2

PREMiSE v2 convierte el contrato en un vertical slice utilizable, sin confundirlo con una plataforma cloud completa:

| Capa | Qué resuelve | Implementación |
| --- | --- | --- |
| **Contrato** | Evidencias múltiples, confianza declarada, conflictos, temporalidad, tenancy, migración v1 y eventos idempotentes. | [`spec/v2`](./spec/v2/) y [`@premise/protocol-types`](./packages/protocol-types/). |
| **Runtime** | Registro, dependencias, propagación de cambios, revalidación, snapshots y replay. | [`@premise/runtime-core`](./packages/runtime-core/). |
| **Persistencia** | Memorias y eventos durables en SQLite, más un adapter PostgreSQL sin acoplar el proyecto a un driver concreto. | [`store-sqlite`](./packages/store-sqlite/) y [`store-postgres`](./packages/store-postgres/). |
| **Integración** | GitHub REST real opt-in con ETag, reintentos, rate limits, checks, reviews y webhooks firmados. | [`validator-github`](./packages/validator-github/). |
| **Contexto** | Retrieval híbrido opcional y selección con presupuesto, gates de frescura, jerarquía y deduplicación. | [`index-hybrid`](./packages/index-hybrid/) y [`context-engine`](./packages/context-engine/). |
| **API** | HTTP/JSON v1 compatible y entrypoint HTTP v2 para registrar, consultar, revalidar y señalar cambios. | [`premise-server`](./packages/premise-server/). |
| **Evaluación** | Baselines comparables, tablas sencillas, trazas por tarea y campañas live separadas de fixtures. | [`benchmarks/real-world-v2`](./benchmarks/real-world-v2/). |

### Cómo funciona visualmente

![Vista general del ciclo de PREMiSE](assets/premise-overview.jpg)

![Arquitectura visual de la capa de validez de PREMiSE](assets/premise-validity-architecture.png)

El flujo es deliberadamente sencillo:

```text
registrar recuerdo + evidencia
          ↓
avisar de un cambio o detectar que debe revalidarse
          ↓
propagar el estado por sus dependencias
          ↓
revalidar con un adapter de la fuente
          ↓
consultar check() antes de actuar
```

## Números fáciles de leer

La fixture temporal v2 ejecutada en este repositorio contiene 100 tareas y tres estrategias. Tiene cambios conocidos para que una cache TTL pueda equivocarse y PREMiSE tenga que invalidar por evento:

| Estrategia | Correctas / 100 | Peticiones / 100 | p95 local |
| --- | ---: | ---: | ---: |
| Lectura directa | 100 | 100 | 0,001 ms |
| Cache TTL de 20 tareas | 96 | 25 | 0,002 ms |
| Cache con eventos PREMiSE | 100 | 8 | 0,003 ms |

También se ejecutó el perfil de contexto gigante con un presupuesto de 128.000 tokens:

| Memorias candidatas | Objetivo conservado | p95 local | Heap observado |
| ---: | :---: | ---: | ---: |
| 10.000 | Sí | 23,986 ms | 35,1 MB |
| 100.000 | Sí | 207,732 ms | 197,2 MB |
| 1.000.000 | Sí | 3.321,731 ms | 1.743,5 MB |

Son mediciones de esta máquina y del workload versionado; no son promesas de producción ni de calidad de un modelo.

## Benchmark real contra GitHub

La campaña live consulta un repositorio real en modo solo lectura. Compara lectura directa, una cache TTL y una cache con comprobaciones condicionales ETag. No inventa un resultado live cuando faltan credenciales o permisos.

```powershell
$env:PREMISE_GITHUB_REPO = "owner/repository"
$env:GITHUB_TOKEN = "ghp_..." # recomendado; nunca lo guardes en el repositorio
pnpm benchmark:v2:live
```

La campaña conserva [resultados](./benchmarks/real-world-v2/results.json), [tablas](./benchmarks/real-world-v2/report.md) y [trazas por tarea](./benchmarks/real-world-v2/traces.jsonl). La fixture que sí se ejecuta en CI se lanza con:

```powershell
pnpm benchmark:v2:offline
pnpm benchmark:v2:giant
```

Las reglas para convertir una cifra en una promesa están en [`docs/v2-benchmarking.md`](./docs/v2-benchmarking.md).

## Qué no es PREMiSE

PREMiSE no pretende ser una base de datos vectorial, un sistema de embeddings, un motor de retrieval, una memoria principal, un dashboard, un servicio cloud ni una autoridad universal sobre la verdad. La v2 incluye componentes opcionales para integrarse con esas piezas, pero no cambia la identidad del protocolo.

El provider vectorial se inyecta. El fallback local del índice es determinista y léxico, no un embedding semántico. El adapter GitHub es real y opt-in, pero sus credenciales, permisos, límites de API y disponibilidad pertenecen a quien lo despliega. Las firmas de v2 son declaraciones que debe verificar una capa de confianza externa.

## Empezar

Necesitas Node.js 24 y pnpm 10:

```bash
git clone https://github.com/Dafenxz0/premise-protocol.git
cd premise-protocol
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Gates principales:

```bash
pnpm conformance:v2
pnpm benchmark:v2:offline
pnpm benchmark:v2:giant
pnpm examples:verify
```

El servidor v1 mantiene el entrypoint original. La superficie v2 se importa explícitamente desde `@premise/premise-server/v2` para evitar romper integraciones existentes.

## Dónde está cada cosa

| Ruta | Para qué sirve |
| --- | --- |
| [`spec/`](./spec/) | Contratos, JSON Schemas y vectores compartidos. |
| [`docs/`](./docs/) | Arquitectura, benchmark y checklist de producción. |
| [`packages/protocol-types`](./packages/protocol-types/) | Tipos y validación v0.1/v2. |
| [`packages/runtime-core`](./packages/runtime-core/) | Runtime v2 y store en memoria de referencia. |
| [`packages/store-sqlite`](./packages/store-sqlite/) | Store SQLite durable y compatibilidad con el sidecar existente. |
| [`packages/store-postgres`](./packages/store-postgres/) | Adapter PostgreSQL driver-neutral y migraciones. |
| [`packages/validator-github`](./packages/validator-github/) | REST, ETag, rate limits, checks, reviews y webhooks GitHub. |
| [`packages/index-hybrid`](./packages/index-hybrid/) | BM25 + provider vectorial inyectable con explicaciones de retrieval. |
| [`packages/context-engine`](./packages/context-engine/) | Selección de contexto con presupuesto y trazabilidad. |
| [`packages/premise-server`](./packages/premise-server/) | API HTTP v1 y v2. |
| [`benchmarks/`](./benchmarks/) | Benchmarks aplicados, comparativos, corpus y contexto gigante. |
| [`assets/`](./assets/) | Logo, overview y arquitectura visual del producto. |

## Estado y límites de salida

`v0.2.0-rc.1` es un release candidate técnico. El contrato, runtime, adapters, persistencia local, API y benchmarks están versionados y probados; aún hacen falta campañas de despliegue para declarar GA: PostgreSQL real, carga de 1M en infraestructura objetivo, chaos/soak, revisión de seguridad independiente, dos entornos cloud, holdout ciego e intervalos de confianza.

El detalle está en [`docs/v2-production-checklist.md`](./docs/v2-production-checklist.md). Este repositorio no incluye una licencia pública por diseño.
