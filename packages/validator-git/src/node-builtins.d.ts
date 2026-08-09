declare module "node:child_process" {
  export function execFileSync(file: string, args: readonly string[], options: { cwd: string; encoding: "utf8" }): string;
}
declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
