declare module "node:crypto" {
  export interface KeyObjectLike {
    readonly type: "private" | "public" | "secret";
    readonly asymmetricKeyType?: string;
  }

  export type KeyLike = KeyObjectLike | string | Uint8Array;

  export interface KeyObjectInput {
    readonly key: string | Uint8Array;
    readonly format?: "pem" | "der";
    readonly type?: "pkcs1" | "pkcs8" | "sec1" | "spki";
  }

  export function createPublicKey(key: KeyLike | KeyObjectInput): KeyObjectLike;
  export function verify(algorithm: null, data: string | Uint8Array, key: KeyLike, signature: string | Uint8Array): boolean;
}

interface PremiseProtocolBuffer extends Uint8Array {
  toString(encoding?: "base64" | "utf8"): string;
}

interface PremiseProtocolBufferConstructor {
  from(input: string | Uint8Array, encoding?: "base64" | "utf8"): PremiseProtocolBuffer;
}

declare const Buffer: PremiseProtocolBufferConstructor;
