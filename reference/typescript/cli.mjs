import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runVectors } from "./dist/index.js";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: node reference/typescript/cli.mjs <vector-file-or-manifest>");
const input = JSON.parse(await readFile(inputPath, "utf8"));
const vectors = Array.isArray(input.vectors) && input.vectors.every((item) => typeof item === "string")
  ? await Promise.all(input.vectors.map(async (name) => JSON.parse(await readFile(resolve(dirname(inputPath), name), "utf8"))))
  : input.vectors ?? [input];
console.log(JSON.stringify(runVectors(vectors)));
