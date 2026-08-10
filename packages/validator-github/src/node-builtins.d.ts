declare module "node:crypto" {
  export interface Hash {
    update(input: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }

  export interface Hmac {
    update(input: string | Uint8Array): Hmac;
    digest(encoding: "hex"): string;
  }

  export function createHash(algorithm: "sha256"): Hash;
  export function createHmac(algorithm: "sha256", key: string | Uint8Array): Hmac;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
