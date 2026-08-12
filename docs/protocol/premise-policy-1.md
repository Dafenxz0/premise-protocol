# PREMiSE `premise-policy/1`: presupuesto de coherencia

La policy puede reducir trabajo sin cambiar el resultado de seguridad del core.
Negocia las capacidades reales del adaptador y escoge cómo revalidar.

Puede decidir, por ejemplo:

- no volver a leer una fuente declarada inmutable;
- agrupar lecturas compatibles;
- compartir una validación dentro de la misma clave de alcance;
- reutilizar una lease mientras no haya un evento invalidante;
- exigir evidencia más fuerte para acciones críticas.

No puede convertir `REJECT` o `REVALIDATE` en `USE`, eliminar una dependencia
crítica ni compartir un receipt entre tenants, permisos o encarnaciones
distintos.
