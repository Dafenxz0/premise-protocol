declare module "node:crypto" {
  interface Hash {
    update(input: string, encoding?: "utf8"): Hash;
    digest(encoding: "hex"): string;
  }

  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
}
