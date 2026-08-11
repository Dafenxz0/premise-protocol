import { createHash, timingSafeEqual } from "node:crypto";

const MAX_BEARER_TOKEN_LENGTH = 4_096;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;
const BEARER_AUTHORIZATION = new RegExp(`^Bearer ([\\x21-\\x7e]{1,${MAX_BEARER_TOKEN_LENGTH}})$`, "u");

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}
function sameSecret(left, right) {
  const leftDigest = digest(left);
  const rightDigest = digest(right);
  return timingSafeEqual(leftDigest, rightDigest);
}

function bearerToken(request) {
  const authorization = request.headers?.authorization;
  if (typeof authorization !== "string") return undefined;
  const match = BEARER_AUTHORIZATION.exec(authorization);
  return match?.[1];
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Operational endpoints use the same bearer boundary as the API. */
export function authorizeOperationalRequest(authorizer, request, principal, { allowLoopback = false } = {}) {
  if (allowLoopback && isLoopbackAddress(request.socket?.remoteAddress)) return true;
  return authorizer === undefined || authorizer(request, principal) !== false;
}

/** RLS is not a boundary for PostgreSQL superusers or roles with BYPASSRLS. */
export function assertRlsSafeDatabaseRole(result) {
  const role = result?.rows?.[0];
  if (role === undefined || role.rolsuper !== false || role.rolbypassrls !== false) {
    throw new Error("PostgreSQL application role must be NOSUPERUSER and NOBYPASSRLS before PREMiSE can start");
  }
}

/**
 * Creates the API authorizer used by the production-shaped service.
 * Development may be left open for local smoke tests; production never is.
 */
export function createBearerAuthorizer({ environment, token, tenantId, tokenName = "PREMISE_API_TOKEN" }) {
  const configuredToken = typeof token === "string" && token.length > 0 ? token : undefined;
  const development = typeof environment === "string" && environment.trim().toLowerCase() === "development";
  if (configuredToken !== undefined && (!VISIBLE_ASCII.test(configuredToken) || configuredToken.length > MAX_BEARER_TOKEN_LENGTH)) {
    throw new Error(`${tokenName} must contain only visible ASCII characters and be at most ${MAX_BEARER_TOKEN_LENGTH} characters`);
  }
  if (!development && configuredToken === undefined) {
    throw new Error(`${tokenName} must be configured outside development`);
  }
  if (!development && configuredToken.length < 32) {
    throw new Error(`${tokenName} must be a high-entropy token of at least 32 characters outside development`);
  }
  if (configuredToken === undefined) return undefined;

  return (request, requestedPrincipal) => {
    const candidate = bearerToken(request);
    if (candidate === undefined || !sameSecret(candidate, configuredToken)) return false;
    return { ...requestedPrincipal, tenantId };
  };
}
