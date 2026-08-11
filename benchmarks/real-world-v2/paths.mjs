import path from "node:path";
import { pathToFileURL } from "node:url";

const configuredDirectory = process.env.PREMISE_BENCHMARK_OUTPUT_DIR;
const directoryUrl = configuredDirectory === undefined
  ? new URL("./", import.meta.url)
  : pathToFileURL(`${path.resolve(configuredDirectory)}${path.sep}`);

export function artifactUrl(name) {
  return new URL(`./${name}`, directoryUrl);
}

export function artifactDirectoryUrl() {
  return directoryUrl;
}
