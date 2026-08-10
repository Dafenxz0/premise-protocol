declare module "node:crypto" {
  export interface KeyObjectLike {
    readonly type: "private" | "public" | "secret";
    readonly asymmetricKeyType?: string;
  }

  export type KeyLike = KeyObjectLike | string | Uint8Array;

  export interface KeyPairKeyObjectResult {
    readonly publicKey: KeyObjectLike;
    readonly privateKey: KeyObjectLike;
  }

  export function generateKeyPairSync(type: "ed25519"): KeyPairKeyObjectResult;
  export function sign(algorithm: null, data: string | Uint8Array, key: KeyLike): Uint8Array;
  export function verify(algorithm: null, data: string | Uint8Array, key: KeyLike, signature: string | Uint8Array): boolean;

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
  export function randomBytes(size: number): Uint8Array;
  export function randomUUID(): string;

  export interface CipherGCM {
    update(input: string | Uint8Array): Uint8Array;
    final(): Uint8Array;
    setAAD(input: Uint8Array): CipherGCM;
    getAuthTag(): Uint8Array;
  }

  export interface DecipherGCM {
    update(input: string | Uint8Array): Uint8Array;
    final(): Uint8Array;
    setAAD(input: Uint8Array): DecipherGCM;
    setAuthTag(input: Uint8Array): DecipherGCM;
  }

  export function createCipheriv(algorithm: "aes-256-gcm", key: Uint8Array, iv: Uint8Array): CipherGCM;
  export function createDecipheriv(algorithm: "aes-256-gcm", key: Uint8Array, iv: Uint8Array): DecipherGCM;
}

interface PremiseSecurityBuffer extends Uint8Array {
  toString(encoding?: "base64" | "hex" | "utf8"): string;
}

interface PremiseSecurityBufferConstructor {
  from(input: string | Uint8Array, encoding?: "base64" | "hex" | "utf8"): PremiseSecurityBuffer;
  concat(chunks: readonly Uint8Array[]): PremiseSecurityBuffer;
}

declare const Buffer: PremiseSecurityBufferConstructor;
