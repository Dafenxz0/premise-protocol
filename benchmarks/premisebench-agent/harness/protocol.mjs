const forbidden = /^(expected|oracle|groundTruth|mutation|outcome|label)$/i;

export function assertAgentSafe(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAgentSafe(item, `${path}[${index}]`));
    return value;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.test(key)) throw new Error(`oracle field ${path}.${key} cannot cross the agent boundary`);
      assertAgentSafe(child, `${path}.${key}`);
    }
  }
  return value;
}

export function startMessage({ taskId, source, memory }) {
  const message = { protocol: "premisebench-agent/1", type: "start", taskId, source, memory, tools: ["read", "act", "actIfVersion", "reject"] };
  assertAgentSafe(message);
  return message;
}

export function parseCandidateMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("candidate message must be an object");
  if (value.protocol !== "premisebench-agent/1") throw new Error("candidate protocol mismatch");
  if (!["read", "act", "actIfVersion", "reject", "done"].includes(value.type)) throw new Error(`unsupported candidate message: ${String(value.type)}`);
  if (value.type === "actIfVersion" && typeof value.expectedVersion !== "string") throw new Error("actIfVersion requires expectedVersion");
  return value;
}
