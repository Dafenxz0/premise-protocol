declare const process: {
  readonly argv: readonly string[];
  exitCode?: number;
};

declare const console: {
  log(message: string): void;
  error(message: string): void;
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
  export function resolve(path: string): string;
}
