/** Minimal typings for Node's built-in `node:sqlite` (the package has no @types/node). */
declare module "node:sqlite" {
  type Value = null | number | bigint | string | Uint8Array;

  export class StatementSync {
    all(...params: unknown[]): Record<string, Value>[];
    get(...params: unknown[]): Record<string, Value> | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    columns(): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string);
    readonly isTransaction: boolean;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

/** Minimal typings for Node's `node:v8` (outbox.bytes.test.ts measures queue bodies with it). */
declare module "node:v8" {
  export function serialize(value: unknown): Uint8Array;
}
