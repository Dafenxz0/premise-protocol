import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runEvolutionVectors, type EvolutionProfile } from "./evolution.js";

const input = process.argv[2];
if (input === undefined) {
  console.error("Usage: node dist/cli-evolution.js <manifest.json>");
  process.exitCode = 2;
} else {
  try {
    const path = resolve(input);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { protocol: EvolutionProfile; profile?: EvolutionProfile; vectors: readonly (string | { readonly file: string })[] };
    const document = { vectors: manifest.vectors.map((entry) => JSON.parse(readFileSync(join(dirname(path), typeof entry === "string" ? entry : entry.file), "utf8"))) };
    console.log(JSON.stringify(runEvolutionVectors(document, manifest.profile ?? manifest.protocol)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
