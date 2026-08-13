import { coordinate } from "./index.mjs";

const candidateCode = [
  "let text = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => text += chunk);",
  "process.stdin.on('end', () => {",
  "  const input = JSON.parse(text);",
  "  const decision = input.public.eventDelivered ? 'REJECT' : 'USE';",
  "  process.stdout.write(JSON.stringify({ type: 'plan', plan: { decision, trace: { eventObserved: Boolean(input.public.eventDelivered) } } }) + '\\n');",
  "});"
].join("\n");

export async function runIsolationSmoke() {
  const result = await coordinate({
    command: process.execPath,
    args: ["-e", candidateCode],
    publicPayload: {
      taskId: "opaque-task",
      eventDelivered: true,
      graph: [{ id: "opaque-node" }]
    },
    privatePayload: {
      actualAffectedTarget: true,
      mutationSchedule: [{ version: "private" }]
    },
    oracle: ({ candidate }) => ({
      safe: candidate.plan.decision === "REJECT",
      candidateDecision: candidate.plan.decision
    })
  });
  return Object.freeze({
    candidateDecision: result.candidate.plan.decision,
    safe: result.oracle.safe,
    privateDataStayedPrivate: result.candidate.publicPayload.actualAffectedTarget === undefined
  });
}

if (process.argv[1] && process.argv[1].endsWith("smoke.mjs")) {
  process.stdout.write(`${JSON.stringify(await runIsolationSmoke(), null, 2)}\n`);
}
