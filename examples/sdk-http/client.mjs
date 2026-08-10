import { PremiseClient, PremiseHttpError } from "@premise/sdk";

const at = new Date().toISOString();
const tenantId = process.env.PREMISE_TENANT ?? "tenant:example";
const token = process.env.PREMISE_TOKEN;
const client = new PremiseClient({
  baseUrl: process.env.PREMISE_URL ?? "http://127.0.0.1:3000/",
  tenantId,
  ...(token === undefined ? {} : { token }),
  timeoutMs: 5_000,
  maxRetries: 2
});

const capabilities = await client.capabilities();
console.log(`Servidor PREMiSE ${capabilities.specVersion}: ${capabilities.capabilities.join(", ")}`);

const record = {
  envelope: {
    specVersion: "premise/2",
    tenantId,
    memoryId: "memory:example:1",
    evidence: [{
      evidenceId: "evidence:example:1",
      sourceUri: "example://getting-started",
      observedAt: at
    }],
    confidence: { score: null, method: "manual", assessedAt: at },
    conflicts: [],
    temporal: { asOf: at },
    validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
    dependsOn: [],
    signatures: []
  },
  content: "La memoria de ejemplo está respaldada por una fuente explícita."
};

const stored = await client.registerMemory(record, {
  idempotencyKey: "example:memory:1"
});
console.log("Registrada:", stored.memoryId);

const fetched = await client.getMemory(record.envelope.memoryId);
console.log("Contenido:", fetched.content);

try {
  await client.getMemory("memory:missing");
} catch (error) {
  if (error instanceof PremiseHttpError) console.error(`API ${error.status} (${error.code}): ${error.message}`);
  else throw error;
}
