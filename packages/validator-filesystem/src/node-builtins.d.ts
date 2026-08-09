declare module "node:crypto" {
  export function createHash(algorithm: string): { update(input: Uint8Array): { digest(encoding: "hex"): string } };
}
declare module "node:fs/promises" {
  export function readFile(path: string): Promise<Uint8Array>;
}
declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
