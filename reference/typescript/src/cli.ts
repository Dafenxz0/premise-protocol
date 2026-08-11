import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runVectors } from "./index.js";

const input = process.argv[2];

if (input === undefined || input === "--help") {
  console.error("Usage: node dist/cli.js <vector.json|manifest.json>");
  process.exitCode = 2;
} else {
  try {
    const path = resolve(input);
    const document = JSON.parse(readFileSync(path, "utf8")) as { readonly vectors?: readonly (string | unknown)[] };
    const vectors = Array.isArray(document.vectors) && document.vectors.every((item) => typeof item === "string")
      ? document.vectors.map((name) => JSON.parse(readFileSync(join(dirname(path), name as string), "utf8")) as unknown)
      : document;
    console.log(JSON.stringify(runVectors(vectors)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
