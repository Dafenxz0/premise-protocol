import { createHash } from "node:crypto";

const FORMAT = "premise-v2-backup";
const VERSION = 1;

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function createBackup(snapshot) {
  const payload = { format: FORMAT, version: VERSION, snapshot };
  return { ...payload, sha256: digest(payload) };
}

export function parseBackup(value) {
  if (value === null || typeof value !== "object" || value.format !== FORMAT || value.version !== VERSION || value.snapshot === undefined || typeof value.sha256 !== "string") throw new Error("Unsupported PREMiSE backup format");
  const payload = { format: value.format, version: value.version, snapshot: value.snapshot };
  if (digest(payload) !== value.sha256) throw new Error("PREMiSE backup checksum mismatch");
  if (value.snapshot.format !== "premise-runtime-snapshot" || value.snapshot.version !== 1 || !Array.isArray(value.snapshot.records) || !Array.isArray(value.snapshot.events)) throw new Error("PREMiSE backup snapshot is invalid");
  return value.snapshot;
}
