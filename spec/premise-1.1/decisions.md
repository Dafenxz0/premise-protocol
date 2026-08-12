# Decisiones de coherencia `premise/1.1`

## 1. Tabla normativa

`check` devuelve una `decision` con el estado de coherencia y una frontera.

| Condición | `coherence` | `decision` | `frontier` |
| --- | --- | --- | --- |
| Premise Set cerrada y snapshot exacto | `COHERENT` | `USE` | `[]` |
| Identidad o dependencia causal no coincide y la frontera pedida es exacta o se omite | `INCOHERENT` | `REVALIDATE` | Frontera mínima calculada |
| Falta cierre, hay tenant cruzado/ciclo, o la frontera pedida no es exacta | `INCOMPLETE` o `INCOHERENT` | `REJECT` | Frontera calculada, si existe |

`USE` nunca se puede emitir para `INCOHERENT` o `INCOMPLETE`. `REVALIDATE` no
autoriza un `apply`; primero deben obtenerse observaciones nuevas y luego
construirse otro change set con otro snapshot.

## 2. Coherencia

Una Premise Set es `COHERENT` si y solo si:

1. todos sus IDs tienen el tenant del set;
2. cada `(tenantId, resourceId)` aparece una sola vez;
3. el grafo de `dependsOn` es acíclico y cerrado;
4. cada dependencia coincide exactamente con el miembro referenciado; y
5. el snapshot tiene el mismo conjunto de recursos, identidades y listas de
   dependencias que `members`.

Una diferencia en `incarnationId`, `versionToken` u `observationId` es una
diferencia causal. Nunca se corrige comparando solo `versionToken`.

## 3. Frontera mínima

La frontera es la menor lista de miembros que hay que volver a observar para
resolver la incoherencia conocida. Se calcula así:

1. ordenar miembros por `(tenantId, resourceId)`;
2. marcar un recurso como `bad` si su miembro no coincide con la entrada del
   snapshot o si una dependencia apunta a una identidad distinta de la del
   miembro referenciado;
3. si una dependencia apunta a un miembro ausente o a otro tenant, clasificar
   el set como `INCOMPLETE` y no inventar una frontera;
4. conservar solo los recursos `bad` que no tienen una dependencia `bad`
   alcanzable. Si `A` depende de `B` y ambos están mal, se conserva `B`;
5. emitir las referencias del miembro conservado, sin `dependsOn`, ordenadas
   por `(tenantId, resourceId)`.

La frontera, por tanto, es un antichain de causas directas. No puede contener
un dependiente cuando ya contiene una causa suya. Una frontera solicitada en
`check.payload.requestedFrontier` debe ser exactamente igual a la calculada,
incluido orden e identidad. Una frontera vacía ante una incoherencia es
`FRONTIER_INCOMPLETE`.

## 4. Aplicación segura

`apply` no usa la tabla `USE/REVALIDATE` como sustituto de la precondición. Solo
se acepta si el `causalSnapshot` del change set coincide con el estado actual,
la acción es válida y el resultado sigue siendo un DAG. Un `ABA_MISMATCH`
ocurre cuando el `resourceId` coincide pero la encarnación, token u
`observationId` observados no coinciden; un token repetido con otra encarnación
no es un mismatch.

Todo fallo de coherencia, scope o precondición produce `REJECTED` y no realiza
efectos laterales.
