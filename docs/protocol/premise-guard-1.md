# PREMiSE `premise-guard/1`: proteger una acción

Un `check` responde si una premisa puede utilizarse. Un guard responde si una
acción puede comprometerse sobre ese estado.

El flujo seguro es:

1. declarar la acción y sus premisas críticas;
2. validar esas premisas y obtener receipts;
3. comprobar tenant, recurso, encarnación, versión, scopes y snapshot;
4. exigir que el adaptador anuncie `CAS`, `CONDITIONAL_ACTION` o
   `ATOMIC_BATCH`;
5. ejecutar el commit condicional;
6. permitir solo si la fuente sigue coincidiendo.

La secuencia `check(); apply();` no es CAS: la fuente puede cambiar entre ambas
llamadas. Si el adaptador no puede hacer la operación condicional, el guard
devuelve `UNSUPPORTED` y no afirma que la acción quedó protegida.
