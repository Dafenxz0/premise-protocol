# PREMiSE protocol conformance

`conformance/run.mjs` es el gate reproducible de las superficies protocolarias
pequeñas. Ejecuta sin red, base de datos, modelo ni API key:

- nueve vectores semánticos compactos de `premise/1`;
- cinco vectores wire históricos de `premise/1`, ejecutados por un state machine
  independiente dentro del gate;
- nueve vectores wire de `premise/1.1`, ejecutados por un state machine
  independiente para identidad, scope, receipts y coherencia causal;
- ocho vectores de `premise/1.1`;
- ocho vectores de `premise-guard/1`;
- cinco vectores de `premise-policy/1`;
- cuatro vectores suplementarios de policy para CAS, coherencia, TTL y
  selección segura de frontera.

Para los perfiles nuevos, TypeScript y Python son referencias separadas y sus
salidas se comparan entre sí y contra los `expected` escritos en cada vector.
Los expected no se generan a partir de ninguna implementación.

```powershell
node conformance/run.mjs
pnpm conformance:protocol
```

El resultado PASS demuestra únicamente que las referencias y los vectores
coinciden. No certifica un adaptador externo, una base de datos, una escritura
remota ni una garantía de disponibilidad.
