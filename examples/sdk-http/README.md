# Ejemplo HTTP v2 con `@premise/sdk`

Este ejemplo muestra el camino mínimo para una aplicación que no conoce aún
PREMiSE: crear un cliente para un tenant, comprobar que el servidor habla
`premise/2`, registrar una memoria y consultarla.

Desde la aplicación que contiene el archivo:

```bash
pnpm add @premise/sdk
PREMISE_URL=http://127.0.0.1:3000/ node client.mjs
```

Puedes definir `PREMISE_TENANT` y `PREMISE_TOKEN`. La clave de idempotencia
del registro es estable: si la misma petición se repite, el servidor v2 puede
devolver el replay sin crear otra mutación.

El servidor local de referencia usa HTTP y un store de replay en memoria. En
producción necesitas TLS, autenticación empresarial/autorización, un store
duradero y compartido, y KMS/cifrado gestionado por tu infraestructura; este
ejemplo no los proporciona.

Código ejecutable: [`client.mjs`](./client.mjs).
