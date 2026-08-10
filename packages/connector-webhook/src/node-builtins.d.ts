declare module "node:crypto" {
  export interface Hmac {
    update(input: string | Uint8Array): Hmac;
    digest(encoding: "hex"): string;
  }

  export function createHmac(algorithm: "sha256", key: string | Uint8Array): Hmac;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
