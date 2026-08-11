import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalizeMemoryEnvelopeV2Signature } from "../../packages/protocol-types/dist/index.js";

const DEFAULT_KEY_ID = "key:ga-client";
const DEFAULT_SIGNER_ID = "agent:ga-client";

function printable(value, name, fallback) {
  const result = value ?? fallback;
  if (typeof result !== "string" || result.length === 0 || result.length > 256 || result.trim() !== result || !/^[\x21-\x7e]+$/u.test(result)) {
    throw new Error(`${name} must be a non-empty printable value`);
  }
  return result;
}

/**
 * Load a detached Ed25519 signing key for an ephemeral benchmark client.
 * The API service receives only the public key; this private key is intended
 * to be mounted into the one-shot benchmark container, never the API.
 */
export async function loadSignedEnvelopeClient({
  privateKeyFile = process.env.PREMISE_SIGNATURE_PRIVATE_KEY_FILE,
  privateKeyPem = process.env.PREMISE_SIGNATURE_PRIVATE_KEY,
  keyId = process.env.PREMISE_SIGNATURE_CLIENT_KEY_ID,
  signerId = process.env.PREMISE_SIGNATURE_CLIENT_SIGNER_ID,
  required = process.env.PREMISE_REQUIRE_SIGNED_ENVELOPES === "1"
} = {}) {
  const source = privateKeyPem ?? (privateKeyFile === undefined || privateKeyFile.length === 0 ? undefined : await readFile(privateKeyFile, "utf8"));
  if (source === undefined) {
    if (required) throw new Error("production benchmark requires PREMISE_SIGNATURE_PRIVATE_KEY_FILE or PREMISE_SIGNATURE_PRIVATE_KEY");
    return undefined;
  }
  if (typeof source !== "string" || source.length === 0 || source.length > 16_384 || !/PRIVATE KEY/u.test(source)) {
    throw new Error("benchmark signing material must be a PEM private key");
  }
  const privateKey = createPrivateKey(source);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("benchmark signing material must be a private Ed25519 key");
  }
  const resolvedKeyId = printable(keyId, "PREMISE_SIGNATURE_CLIENT_KEY_ID", DEFAULT_KEY_ID);
  const resolvedSignerId = printable(signerId, "PREMISE_SIGNATURE_CLIENT_SIGNER_ID", DEFAULT_SIGNER_ID);
  return {
    keyId: resolvedKeyId,
    signerId: resolvedSignerId,
    signEnvelope(envelope, { signatureId = `sig:ga-client:${randomUUID()}`, evidenceId, signedAt = new Date().toISOString() } = {}) {
      const metadata = {
        signatureId: printable(signatureId, "signatureId", undefined),
        signerId: resolvedSignerId,
        keyId: resolvedKeyId,
        algorithm: "ed25519",
        signedAt,
        ...(evidenceId === undefined ? {} : { evidenceId: printable(evidenceId, "evidenceId", undefined) })
      };
      const value = sign(null, Buffer.from(canonicalizeMemoryEnvelopeV2Signature(envelope, metadata), "utf8"), privateKey).toString("base64");
      return { ...envelope, signatures: [{ ...metadata, value }] };
    }
  };
}
