import { PremiseClient } from "@premise/sdk";

export function createClient({ baseUrl, tenantId, token } = {}) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new TypeError("baseUrl is required");
  }
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new TypeError("tenantId is required");
  }

  const options = { baseUrl, tenantId, maxRetries: 0 };
  if (token !== undefined) options.token = token;
  return new PremiseClient(options);
}
