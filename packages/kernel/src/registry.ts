/**
 * Prototype registries for the data stages (data -> dataUpdates -> dataFinal),
 * frozen and hashed once all stages ran.
 */
import { cloneJson, compareStrings, deepFreeze, stableHash } from "./hash.ts";
import type { FrozenRegistry, Registry } from "./types.ts";

interface Entry {
  proto: object;
  /** Module that defined the prototype (null outside the loader). */
  definedBy: string | null;
}

function sortedEntries<T>(table: Map<string, T> | undefined): [string, T][] {
  if (!table) return [];
  return [...table.entries()].sort((a, b) => compareStrings(a[0], b[0]));
}

function assertKey(kind: string, id: string): void {
  if (typeof kind !== "string" || kind === "")
    throw new TypeError("Registry kind must be a non-empty string");
  if (typeof id !== "string" || id === "")
    throw new TypeError(`Registry id for kind "${kind}" must be a non-empty string`);
}

function assertProto(kind: string, id: string, proto: unknown): object {
  if (typeof proto !== "object" || proto === null || Array.isArray(proto)) {
    throw new TypeError(`Prototype ${kind} "${id}" must be a plain object`);
  }
  return cloneJson(proto, `${kind}["${id}"]`);
}

class FrozenRegistryImpl implements FrozenRegistry {
  readonly hash: string;
  private readonly tables: Map<string, Map<string, object>>;
  private readonly lists = new Map<string, ReadonlyArray<readonly [string, object]>>();

  constructor(tables: Map<string, Map<string, object>>) {
    this.tables = tables;
    const canonical: Record<string, [string, object][]> = {};
    for (const [kind, table] of sortedEntries(tables)) {
      const list = Object.freeze(sortedEntries(table).map((pair) => Object.freeze(pair)));
      this.lists.set(kind, list);
      canonical[kind] = list as [string, object][];
    }
    this.hash = stableHash(canonical);
  }

  has(kind: string, id: string): boolean {
    return this.tables.get(kind)?.has(id) ?? false;
  }

  get<T extends object>(kind: string, id: string): Readonly<T> | undefined {
    return this.tables.get(kind)?.get(id) as Readonly<T> | undefined;
  }

  require<T extends object>(kind: string, id: string): Readonly<T> {
    const proto = this.get<T>(kind, id);
    if (proto === undefined) {
      const known = this.tables.has(kind)
        ? `${this.tables.get(kind)!.size} ${kind} prototypes defined`
        : `no "${kind}" prototypes defined at all`;
      throw new Error(`Registry: missing ${kind} "${id}" (${known})`);
    }
    return proto;
  }

  all<T extends object>(kind: string): ReadonlyArray<readonly [string, Readonly<T>]> {
    return (this.lists.get(kind) ?? []) as ReadonlyArray<readonly [string, Readonly<T>]>;
  }

  kinds(): string[] {
    return [...this.lists.keys()];
  }
}

/** Mutable registry used during the data stages; the loader attributes writes to the current module. */
export class RegistryImpl implements Registry {
  private readonly tables = new Map<string, Map<string, Entry>>();
  private owner: string | null = null;
  private frozen = false;

  /** Sets the module that subsequent writes are attributed to (for error messages). */
  setOwner(moduleId: string | null): void {
    this.owner = moduleId;
  }

  define<T extends object>(kind: string, id: string, proto: T): void {
    this.assertMutable("define");
    assertKey(kind, id);
    let table = this.tables.get(kind);
    if (!table) {
      table = new Map();
      this.tables.set(kind, table);
    }
    const existing = table.get(id);
    if (existing) {
      const by = existing.definedBy ? ` by module "${existing.definedBy}"` : "";
      const self = this.owner ? `module "${this.owner}" ` : "";
      throw new Error(
        `Registry: ${self}cannot define ${kind} "${id}": already defined${by} (use patch() to change it)`,
      );
    }
    table.set(id, { proto: assertProto(kind, id, proto), definedBy: this.owner });
  }

  patch<T extends object>(kind: string, id: string, fn: (proto: T) => T | void): void {
    this.assertMutable("patch");
    assertKey(kind, id);
    const entry = this.tables.get(kind)?.get(id);
    if (!entry) {
      const self = this.owner ? `module "${this.owner}" ` : "";
      throw new Error(`Registry: ${self}cannot patch ${kind} "${id}": it is not defined`);
    }
    const result = fn(entry.proto as T);
    // Re-clone either way: validates the mutated/replaced value and drops any aliasing.
    entry.proto = assertProto(kind, id, result === undefined ? entry.proto : result);
  }

  remove(kind: string, id: string): void {
    this.assertMutable("remove");
    const table = this.tables.get(kind);
    if (!table) return;
    table.delete(id);
    if (table.size === 0) this.tables.delete(kind);
  }

  has(kind: string, id: string): boolean {
    return this.tables.get(kind)?.has(id) ?? false;
  }

  get<T extends object>(kind: string, id: string): T | undefined {
    return this.tables.get(kind)?.get(id)?.proto as T | undefined;
  }

  all<T extends object>(kind: string): ReadonlyArray<readonly [string, T]> {
    return sortedEntries(this.tables.get(kind)).map(([id, e]) => [id, e.proto as T] as const);
  }

  /** Deep-freezes everything into a read-only registry. The mutable registry rejects writes afterwards. */
  freeze(): FrozenRegistry {
    this.assertMutable("freeze");
    this.frozen = true;
    const tables = new Map<string, Map<string, object>>();
    for (const [kind, table] of sortedEntries(this.tables)) {
      const out = new Map<string, object>();
      for (const [id, e] of sortedEntries(table)) out.set(id, deepFreeze(cloneJson(e.proto)));
      tables.set(kind, out);
    }
    return new FrozenRegistryImpl(tables);
  }

  private assertMutable(op: string): void {
    if (this.frozen) throw new Error(`Registry: cannot ${op}() after freeze()`);
  }
}

/** Mutable registry used during the data stages. */
export function createRegistry(): Registry & { freeze(): FrozenRegistry } {
  return new RegistryImpl();
}
