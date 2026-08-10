# @premise/runtime-core

Runtime v2 de referencia para aplicar el contrato `premise/2`.

Incluye un store en memoria, registro y derivación con aislamiento por tenant, propagación de `SourceChanged` por dependencias, revalidación mediante validators inyectables, eventos idempotentes y snapshots restaurables. El runtime conserva el contenido que le entrega la aplicación: PREMiSE no reemplaza el sistema de memoria ni pretende ser una autoridad universal sobre la verdad.

Para producción, sustituye `InMemoryRuntimeStore` por un store durable compatible como `@premise/store-sqlite` o el adapter PostgreSQL.
