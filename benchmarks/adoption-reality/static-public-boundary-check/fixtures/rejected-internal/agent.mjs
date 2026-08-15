import { PremiseClient } from "@premise/sdk";
import { PremiseSession } from "@premise/runtime-core";

export function createClient(options) {
  return new PremiseClient(options);
}

export { PremiseSession };
