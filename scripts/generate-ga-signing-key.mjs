import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function argument(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log("Usage: node scripts/generate-ga-signing-key.mjs [--public PATH] [--private PATH]");
  process.exit(0);
}
const publicPath = path.resolve(argument(argv, "--public", ".local/premise_signature_public_keys.json"));
const privatePath = path.resolve(argument(argv, "--private", ".local/premise_signature_private_key.pem"));
if (publicPath === privatePath) throw new Error("public and private key paths must differ");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
await mkdir(path.dirname(publicPath), { recursive: true });
await mkdir(path.dirname(privatePath), { recursive: true });
await writeFile(publicPath, `${JSON.stringify({ "key:ga-client": publicKey.export({ type: "spki", format: "pem" }) }, null, 2)}\n`, { mode: 0o600 });
await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
console.log(JSON.stringify({ publicPath, privatePath, keyId: "key:ga-client", algorithm: "ed25519" }));

