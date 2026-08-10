declare module "node:sqlite" {
  type SQLInputValue = string | number | bigint | Uint8Array | null;

  export interface StatementResultingChanges {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  }

  export interface StatementSync {
    run(...parameters: SQLInputValue[]): StatementResultingChanges;
    get(...parameters: SQLInputValue[]): Record<string, unknown> | undefined;
    all(...parameters: SQLInputValue[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(filename: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
