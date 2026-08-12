# Compatibilidad e interoperabilidad `premise/1.1`

## Perfil obligatorio

Una implementación que anuncie `PREMiSE-compatible premise/1.1` MUST declarar
y cumplir estas capabilities:

- `OBSERVATION`: conserva observaciones con los cinco identificadores;
- `PREMISE_SET`: valida cierre, dependencias y snapshots causales;
- `CHANGE_SET`: aplica transacciones atómicas con precondición exacta;
- `RECEIPT`: conserva receipts y distingue replay de conflicto;
- `TENANCY`: aísla recursos, dependencias, operaciones y receipts por tenant;
- `FRONTIER`: calcula y valida la frontera mínima determinista.

No hay capabilities opcionales en el perfil mínimo. Retrieval, contenido,
firmas, transporte y almacenamiento quedan fuera del wire y no pueden cambiar
una decisión de coherencia.

## Reglas de compatibilidad

1. `specVersion` debe ser exactamente `premise/1.1`; no se acepta por prefijo.
2. El documento debe ajustarse al schema cerrado. Campos, `kind`, acciones,
   razones o capabilities desconocidos se rechazan.
3. Todos los IDs y scopes de un documento deben estar dentro de `tenantId`. Una
   dependencia cross-tenant o sin `scopes` se rechaza incluso si el recurso
   existe.
4. `resourceId` no se reutiliza para ocultar una vida distinta: borrar y crear
   de nuevo requiere un `incarnationId` y `observationId` nuevos.
5. Un retry solo es replay si coinciden el ámbito de idempotencia y
   `requestDigest`; otro digest es conflicto y no muta.
6. Una frontera solicitada debe ser la frontera mínima exacta. El consumidor no
   puede declarar `USE` con una frontera incompleta.
7. Una adaptación debe conservar la historia de IDs y señalar los campos que
   no pueda representar. La pérdida silenciosa de `incarnationId`,
   `observationId` o scope no es compatible.

## Relación con `premise/1`

No hay compatibilidad wire implícita. Un adaptador desde `premise/1` puede:

- mapear `tenantId` y `memoryId` a `tenantId` y `resourceId`;
- convertir cada entrada de `evidence` en una `observation`;
- mapear la versión previa a `versionToken` solo si el adaptador puede emitir
  un `incarnationId` y un `observationId` estables; y
- convertir `dependsOn` en dependencias completas, añadiendo scope y la
  identidad exacta del soporte.

Si `premise/1` no contiene esos valores, el adaptador MUST generar una nueva
observación explícita o rechazar la conversión; no puede inventar una
equivalencia. `register`, `derive` y `replace` de `premise/1` no se convierten
silenciosamente en `apply` de `premise/1.1`: requieren un change set y un
snapshot causal.

## Relación con `premise/2` y futuros perfiles

`premise/2` y cualquier `premise/1.x` distinto de `premise/1.1` requieren una
negociación explícita. Un consumidor `premise/1.1` MUST rechazar el documento
antes de ejecutar una mutación si el `specVersion` no coincide exactamente.
