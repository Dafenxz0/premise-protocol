import { baselines } from "./baselines/index.js";
import { createFilesystemWorld } from "./environments/index.js";
import { runEpisode, type EpisodeDefinition } from "./engine/index.js";
import { evaluate, report } from "./evaluators/index.js";

declare const process: { readonly argv: readonly string[] };
declare const console: { log(...values: readonly unknown[]): void };

export async function runBenchmarkCli(): Promise<unknown> {
  const definition: EpisodeDefinition = { id: "smoke-filesystem-01", sourceUri: "filesystem://resource", reopenBeforeRecall: true, actionRequired: true };
  const trace = await runEpisode(definition, createFilesystemWorld(definition.sourceUri));
  const results = Object.values(baselines).map((baseline) => baseline({ stale: trace.staleRecall, protocolDecision: "REVALIDATE", refresh: () => true }));
  return report(results.map((result) => evaluate(result.name, [trace], [result])));
}

if (process.argv.includes("--runner") || process.argv.includes("--suite")) console.log(JSON.stringify(await runBenchmarkCli(), null, 2));
