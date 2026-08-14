# Public SDK integration

Install the published package in the external application:

```text
npm install @premise/sdk
```

The public client is imported from `@premise/sdk`:

```js
import { PremiseClient } from "@premise/sdk";

const premise = new PremiseClient({
  baseUrl: "https://premise.example.com/",
  tenantId: "tenant:acme",
  token: process.env.PREMISE_TOKEN
});
```

`baseUrl` and `tenantId` are application configuration. A token is supplied
by the caller at runtime; it is never part of source or fixtures. Creating a
client does not make a request. The public client exposes HTTP operations such
as `health()`, `capabilities()`, `query()`, `getMemory()`, `revalidate()`, and
`sourceChanged()`.
