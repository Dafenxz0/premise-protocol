declare module "node:crypto" {
  interface Hash {
    update(input: string, encoding?: "utf8"): Hash;
    digest(encoding: "hex"): string;
  }

  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
}

declare module "node:fs" {
  export function appendFileSync(path: string, data: string, encoding: "utf8"): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options: { recursive: true }): string | undefined;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function renameSync(source: string, target: string): void;
  export function unlinkSync(path: string): void;
  export function writeFileSync(path: string, data: string | Uint8Array, encoding?: "utf8"): void;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}

interface PremiseRuntimeBuffer extends Uint8Array {
  subarray(start?: number, end?: number): PremiseRuntimeBuffer;
}

interface PremiseRuntimeBufferConstructor {
  byteLength(input: string, encoding?: "utf8"): number;
  from(input: string, encoding?: "utf8"): PremiseRuntimeBuffer;
}

declare const Buffer: PremiseRuntimeBufferConstructor;
declare const process: { readonly pid: number };
