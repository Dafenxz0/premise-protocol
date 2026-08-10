import { createInterface } from "node:readline";
import { PremiseRuntime } from "../../../packages/runtime-core/dist/index.js";

const TENANT_ID = "tenant:external-holdout";
const runtime = new PremiseRuntime({ tenantId: TENANT_ID, principal: { tenantId: TENANT_ID, subjectId: "holdout-candidate" } });
let activeTask;
let sequence = 0;

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function nonEmpty(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function recordFrom(task, evidence) {
  const observedAt = new Date().toISOString();
  const memoryId = `holdout:${task.taskId}`;
  const version = evidence.version;
  const sourceUri = nonEmpty(evidence.sourceUri, nonEmpty(evidence.provenance?.sourceUri, `github://opaque/${task.source.id}`));
  const evidenceReference = {
    evidenceId: `evidence:${memoryId}`,
    sourceUri,
    observedAt,
    ...(version === undefined ? {} : { version, validator: { id: "github", operation: "read" } })
  };
  return {
    memoryId,
    record: {
      envelope: {
        specVersion: "premise/2",
        tenantId: TENANT_ID,
        memoryId,
        evidence: [evidenceReference],
        confidence: { score: null, method: "external-holdout", assessedAt: observedAt },
        conflicts: [],
        temporal: { asOf: observedAt },
        validity: { status: "FRESH", checkedAt: observedAt, policy: "VERSIONED" },
        dependsOn: [],
        signatures: []
      },
      content: Object.hasOwn(evidence, "body") ? evidence.body : evidence.content
    }
  };
}

async function handle(message) {
  if (message?.type === "task") {
    if (activeTask !== undefined) throw new Error("received a new task before completing the active task");
    if (!message.task || typeof message.task.taskId !== "string" || !message.task.source || typeof message.task.source.id !== "string") throw new Error("holdout task is invalid");
    activeTask = message.task;
    write({ type: "read", requestId: `read-${sequence++}`, sourceId: activeTask.source.id });
    return;
  }
  if (message?.type === "evidence") {
    if (activeTask === undefined) throw new Error("received evidence without an active task");
    if (message.sourceId !== activeTask.source.id) throw new Error("evidence source does not match the active task");
    const item = recordFrom(activeTask, message);
    runtime.register(item.record);
    const state = runtime.check([item.memoryId])[0];
    if (state?.decision !== "USABLE") {
      write({ type: "answer", answer: null, decision: "REJECT", status: state?.status ?? "UNKNOWN" });
    } else {
      write({ type: "answer", answer: item.record.content, decision: "USE", status: state.status });
    }
    activeTask = undefined;
    return;
  }
  if (message?.type === "end") {
    if (activeTask !== undefined) throw new Error("holdout ended with an incomplete task");
    return "end";
  }
  if (message?.type === "log") return;
  throw new Error(`unsupported holdout message type: ${String(message?.type)}`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    const result = await handle(message);
    if (result === "end") break;
  }
} catch (error) {
  console.error(`[holdout-candidate] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
