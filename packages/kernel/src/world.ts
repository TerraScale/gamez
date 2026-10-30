/**
 * Deterministic ECS world: one sparse store per component name, monotonic
 * entity ids and sorted queries.
 *
 * Values passed to add()/setResource()/update() are deep-cloned, and
 * snapshot() returns deep clones, so callers can never alias internal state.
 * get()/read()/getResource() return the live stored value: mutating it in a
 * system or action is allowed and is covered by snapshots and rollback.
 *
 * Rollback uses an undo log instead of a whole-world snapshot. Between
 * begin() and commit()/rollback() (the sim wraps every dispatch() and step()
 * in one), each change is preceded by a log entry holding what it overwrites:
 * - Membership: a component or resource is added, removed or destroyed. The
 *   entry holds the table, the key and the previous slot (or ABSENT).
 * - Value: a slot's value is replaced (add over an existing component,
 *   setResource over an existing key) or handed out live (get, read,
 *   getResource) or patched in place (update). The entry holds the slot and its
 *   previous value. A replaced value is kept by reference: nothing can reach it
 *   through the world any more. A live value is deep-copied before it is handed
 *   out, because the caller may mutate it in place. Value entries are written
 *   once per slot per transaction (slot.txn); later touches need nothing.
 * - Field: update() of a slot not yet logged, when every patched key already
 *   exists and none is deleted, saves only the old values of those keys (by
 *   reference: update() replaces them with clones and never mutates them), so
 *   a small patch of a big value costs no deep copy. Key order cannot change.
 *   If the slot is then handed out live or replaced in the same transaction,
 *   the field entry is promoted to a value entry (a copy of the value with the
 *   saved fields put back).
 * Entities created in the transaction are exactly the ids from the saved
 * nextEntity upwards; destroyed older ids are listed. rollback() replays the
 * log in reverse, so each table key and each slot ends with the state it had
 * at begin(); commit() drops the log. Both cost what the transaction touched,
 * not the size of the world.
 */
import { cloneJson, cloneValue, compareStrings, copyStored } from "./hash.ts";
import type { ComponentType, Entity, World, WorldSnapshot } from "./types.ts";

/**
 * Reserved component that marks live entities, so entities without any
 * other component survive snapshot/restore. Modules cannot add or remove it.
 */
export const ENTITY_COMPONENT = "kernel.entity";

const byEntity = (a: [Entity, unknown], b: [Entity, unknown]) => a[0] - b[0];

/**
 * Hidden index of a component name (one per name in the process), set by
 * defineComponent(). Worlds use it to find a component's table with an array
 * load instead of a string-keyed Map lookup on every get/peek/has. Handles
 * built by hand (`{ name }`) have none and use the Map.
 */
const COMPONENT_INDEX: unique symbol = Symbol("kernel.componentIndex");
const indexByName = new Map<string, number>();
type Indexed = { readonly [COMPONENT_INDEX]?: number };

/** A component handle for `name` (see COMPONENT_INDEX). */
export function componentHandle<T>(name: string): ComponentType<T> {
  let index = indexByName.get(name);
  if (index === undefined) {
    index = indexByName.size;
    indexByName.set(name, index);
  }
  const handle = { name } as ComponentType<T>;
  Object.defineProperty(handle, COMPONENT_INDEX, { value: index });
  return handle;
}

/** Undo-log marker: the key had no slot before the logged change. */
const ABSENT: unique symbol = Symbol("absent");

const hasOwn = Object.prototype.hasOwnProperty;

/** Values that sim code can mutate in place. */
const isMutable = (v: unknown): v is object => typeof v === "object" && v !== null;

/** Holder of one stored component or resource value. */
class Slot {
  value: unknown;
  /** Transaction that created this slot or already saved its value (0: none). */
  txn: number;
  /** Value at the start of transaction `txn`, while that transaction is open and the slot is in valueLog. */
  prev: unknown = undefined;
  /** Transaction whose field entry this slot holds (in fieldLog), 0: none. */
  fieldTxn = 0;
  /** Field entry: key, old value, key, old value... (each key once). */
  fields: unknown[] | null = null;

  constructor(value: unknown, txn: number) {
    this.value = value;
    this.txn = txn;
  }
}

type Table<K> = Map<K, Slot>;

export class WorldImpl implements World {
  private nextEntity = 1;
  private readonly alive = new Set<Entity>();
  private stores = new Map<string, Table<Entity>>();
  /** Tables by COMPONENT_INDEX: a cache of `stores`, filled on first lookup. */
  private byIndex: (Table<Entity> | undefined)[] = [];
  private resources: Table<string> = new Map();

  // ---- transaction state (see the file comment) ----
  /** Id of the open transaction, 0 when none. */
  private txn = 0;
  private lastTxn = 0;
  private txnNextEntity = 1;
  /** Entities below txnNextEntity destroyed in the transaction. */
  private txnDestroyed: Entity[] = [];
  /** Value entries: slots whose `prev` holds their value at begin(). */
  private valueLog: Slot[] = [];
  /** Membership entries, three items each: table, key, previous slot or ABSENT. */
  private memberLog: unknown[] = [];
  /** Field entries: slots whose `fields` hold the begin values of the keys update() patched. */
  private fieldLog: Slot[] = [];

  /** Starts an undo log. Transactions do not nest. */
  begin(): void {
    if (this.txn !== 0) throw new Error("world.begin(): a transaction is already open");
    this.txn = ++this.lastTxn;
    this.txnNextEntity = this.nextEntity;
  }

  /** Keeps every change since begin() and drops the log. */
  commit(): void {
    this.assertTxn("commit");
    this.endTxn();
  }

  /** Restores the exact state of begin(): entities, components, resources and nextEntity. */
  rollback(): void {
    this.assertTxn("rollback");
    // Slot contents and table membership are independent: each slot's value
    // entry is unique, and membership entries replay in reverse.
    for (const slot of this.valueLog) slot.value = slot.prev;
    for (const slot of this.fieldLog) {
      // Promoted entries (fieldTxn reset) were restored through valueLog.
      if (slot.fieldTxn !== this.txn) continue;
      const target = slot.value as Record<string, unknown>;
      const f = slot.fields!;
      for (let i = 0; i < f.length; i += 2) target[f[i] as string] = f[i + 1];
    }
    const log = this.memberLog;
    for (let i = log.length - 3; i >= 0; i -= 3) {
      const table = log[i] as Table<unknown>;
      const prev = log[i + 2];
      if (prev === ABSENT) table.delete(log[i + 1]);
      else table.set(log[i + 1], prev as Slot);
    }
    for (let e = this.txnNextEntity; e < this.nextEntity; e++) this.alive.delete(e);
    for (const e of this.txnDestroyed) this.alive.add(e);
    this.nextEntity = this.txnNextEntity;
    this.endTxn();
  }

  private endTxn(): void {
    for (const slot of this.valueLog) slot.prev = undefined;
    for (const slot of this.fieldLog) {
      slot.fieldTxn = 0;
      slot.fields = null;
    }
    this.valueLog = [];
    this.fieldLog = [];
    this.memberLog = [];
    this.txnDestroyed = [];
    this.txn = 0;
  }

  private assertTxn(op: string): void {
    if (this.txn === 0) throw new Error(`world.${op}(): no transaction is open`);
  }

  /**
   * Logs a slot's value before it is handed out live or patched in place
   * (`copy`), or replaced by a new value (kept by reference). Once per slot
   * per transaction; a slot created in this transaction needs no entry.
   */
  private logValue(slot: Slot, copy: boolean): void {
    if (slot.txn === this.txn) return;
    if (slot.fieldTxn === this.txn) {
      this.promote(slot);
      return;
    }
    slot.txn = this.txn;
    const v = slot.value;
    slot.prev = copy && isMutable(v) ? copyStored(v) : v;
    this.valueLog.push(slot);
  }

  /**
   * Turns a slot's field entry into a value entry: its begin value is a copy of
   * the current value with the saved fields put back.
   */
  private promote(slot: Slot): void {
    const begin = copyStored(slot.value) as Record<string, unknown>;
    const f = slot.fields!;
    for (let i = 0; i < f.length; i += 2) begin[f[i] as string] = f[i + 1];
    slot.fieldTxn = 0;
    slot.fields = null;
    slot.txn = this.txn;
    slot.prev = begin;
    this.valueLog.push(slot);
  }

  /**
   * Logs the begin values of the keys `update(patch)` is about to replace in
   * `target`. Returns false (nothing logged) when the patch deletes or adds a
   * key: the caller then logs the whole value.
   */
  private logFields(slot: Slot, target: Record<string, unknown>, keys: string[], patch: object): boolean {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if ((patch as Record<string, unknown>)[k] === undefined || !hasOwn.call(target, k)) return false;
    }
    let f = slot.fields;
    if (slot.fieldTxn !== this.txn) {
      slot.fieldTxn = this.txn;
      f = slot.fields = [];
      this.fieldLog.push(slot);
    }
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      let saved = false;
      for (let j = 0; j < f!.length; j += 2) {
        if (f![j] === k) {
          saved = true;
          break;
        }
      }
      if (!saved) f!.push(k, target[k]);
    }
    return true;
  }

  /** Reads a live value; in a transaction, logs a copy first if it is mutable. */
  private live(slot: Slot | undefined): unknown {
    if (slot === undefined) return undefined;
    const v = slot.value;
    if (this.txn !== 0 && slot.txn !== this.txn && isMutable(v)) {
      if (slot.fieldTxn === this.txn) this.promote(slot);
      else {
        slot.txn = this.txn;
        slot.prev = copyStored(v);
        this.valueLog.push(slot);
      }
    }
    return v;
  }

  /** Sets `key` to an already-cloned value, logging what it overwrites. */
  private put<K>(table: Table<K>, key: K, value: unknown): void {
    const slot = table.get(key);
    if (slot === undefined) {
      if (this.txn !== 0) this.memberLog.push(table, key, ABSENT);
      table.set(key, new Slot(value, this.txn));
    } else {
      if (this.txn !== 0) this.logValue(slot, false);
      slot.value = value;
    }
  }

  /** Deletes `key`, logging the slot it held. */
  private drop<K>(table: Table<K>, key: K): void {
    const slot = table.get(key);
    if (slot === undefined) return;
    if (this.txn !== 0) this.memberLog.push(table, key, slot);
    table.delete(key);
  }

  /** The table of a component, or undefined when no value was ever stored. */
  private tableOf(c: ComponentType<unknown>): Table<Entity> | undefined {
    const index = (c as Indexed)[COMPONENT_INDEX];
    if (index === undefined) return this.stores.get(c.name);
    const cached = this.byIndex[index];
    if (cached !== undefined) return cached;
    const table = this.stores.get(c.name);
    if (table !== undefined) this.byIndex[index] = table;
    return table;
  }

  create(): Entity {
    const e = this.nextEntity++;
    this.alive.add(e);
    return e;
  }

  destroy(e: Entity): void {
    if (!this.alive.delete(e)) return;
    if (this.txn !== 0 && e < this.txnNextEntity) this.txnDestroyed.push(e);
    for (const table of this.stores.values()) this.drop(table, e);
  }

  exists(e: Entity): boolean {
    return this.alive.has(e);
  }

  add<T>(e: Entity, c: ComponentType<T>, value: T): void {
    this.assertAlive(e, "add", c.name);
    this.assertNotReserved(c.name);
    const stored = cloneValue(value, c.name, e, null);
    let table = this.tableOf(c);
    if (!table) {
      table = new Map();
      this.stores.set(c.name, table);
    }
    this.put(table, e, stored);
  }

  update<T extends object>(e: Entity, c: ComponentType<T>, patch: Partial<T>): void {
    const slot = this.tableOf(c)?.get(e);
    const current = slot?.value;
    if (current === undefined) {
      throw new Error(`world.update(${e}, "${c.name}"): entity has no such component`);
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new TypeError(`world.update(${e}, "${c.name}"): component value is not an object`);
    }
    const target = current as Record<string, unknown>;
    const keys = Object.keys(patch);
    if (
      this.txn !== 0 &&
      slot!.txn !== this.txn &&
      !this.logFields(slot!, target, keys, patch)
    ) {
      this.logValue(slot!, true);
    }
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const v = (patch as Record<string, unknown>)[k];
      if (v === undefined) delete target[k];
      else target[k] = cloneValue(v, c.name, e, k);
    }
  }

  remove<T>(e: Entity, c: ComponentType<T>): void {
    this.assertNotReserved(c.name);
    const table = this.tableOf(c);
    if (table) this.drop(table, e);
  }

  has<T>(e: Entity, c: ComponentType<T>): boolean {
    return c.name === ENTITY_COMPONENT
      ? this.alive.has(e)
      : (this.tableOf(c)?.has(e) ?? false);
  }

  get<T>(e: Entity, c: ComponentType<T>): T | undefined {
    if (c.name === ENTITY_COMPONENT) return (this.alive.has(e) ? true : undefined) as T | undefined;
    return this.live(this.tableOf(c)?.get(e)) as T | undefined;
  }

  peek<T>(e: Entity, c: ComponentType<T>): Readonly<T> | undefined {
    if (c.name === ENTITY_COMPONENT) return (this.alive.has(e) ? true : undefined) as T | undefined;
    return this.tableOf(c)?.get(e)?.value as T | undefined;
  }

  read<T>(e: Entity, c: ComponentType<T>): T {
    const v = this.get(e, c);
    if (v === undefined)
      throw new Error(`world.read(${e}, "${c.name}"): entity has no such component`);
    return v;
  }

  query(...cs: ComponentType<unknown>[]): Entity[] {
    if (cs.length === 0) return [...this.alive].sort((a, b) => a - b);
    const sets: { has(e: Entity): boolean; size: number; keys(): Iterable<Entity> }[] = [];
    for (const c of cs) {
      if (c.name === ENTITY_COMPONENT) {
        sets.push(this.alive);
        continue;
      }
      const table = this.tableOf(c);
      if (!table || table.size === 0) return [];
      sets.push(table);
    }
    sets.sort((a, b) => a.size - b.size);
    // Hot path (every system queries every tick): plain loops, no closures, and
    // no sort when the ids already come in ascending order (the common case:
    // components are mostly added in creation order).
    const n = sets.length;
    const out: Entity[] = [];
    let sorted = true;
    let last = -Infinity;
    for (const e of sets[0]!.keys()) {
      let all = true;
      for (let i = 1; i < n; i++) {
        if (!sets[i]!.has(e)) {
          all = false;
          break;
        }
      }
      if (!all) continue;
      if (e < last) sorted = false;
      last = e;
      out.push(e);
    }
    return sorted ? out : out.sort((a, b) => a - b);
  }

  getResource<T>(key: string): T | undefined {
    return this.live(this.resources.get(key)) as T | undefined;
  }

  setResource<T>(key: string, value: T): void {
    if (value === undefined)
      throw new TypeError(`world.setResource("${key}", undefined): use deleteResource()`);
    this.put(
      this.resources,
      key,
      cloneJson(value, () => `resource ${key}`),
    );
  }

  deleteResource(key: string): void {
    this.drop(this.resources, key);
  }

  snapshot(): WorldSnapshot {
    const components: Record<string, [Entity, unknown][]> = {};
    if (this.alive.size > 0) {
      components[ENTITY_COMPONENT] = [...this.alive].sort((a, b) => a - b).map((e) => [e, true]);
    }
    for (const name of [...this.stores.keys()].sort(compareStrings)) {
      const table = this.stores.get(name)!;
      if (table.size === 0) continue;
      const rows: [Entity, unknown][] = [];
      for (const [e, s] of table) rows.push([e, cloneJson(s.value, () => `${name}[${e}]`)]);
      components[name] = rows.sort(byEntity);
    }
    const resources: Record<string, unknown> = {};
    for (const key of [...this.resources.keys()].sort(compareStrings)) {
      resources[key] = cloneJson(this.resources.get(key)!.value, () => `resource ${key}`);
    }
    return { nextEntity: this.nextEntity, components, resources };
  }

  /**
   * Replaces this world's whole state with a snapshot (in place, so references
   * to the world stay valid). Not allowed inside a transaction.
   */
  load(snapshot: WorldSnapshot): void {
    if (this.txn !== 0) throw new Error("world.load(): cannot load inside a transaction");
    const { nextEntity, components, resources } = snapshot;
    if (!Number.isSafeInteger(nextEntity) || nextEntity < 1) {
      throw new TypeError(`WorldSnapshot.nextEntity must be a positive integer, got ${nextEntity}`);
    }
    const alive = new Set<Entity>();
    for (const [e] of components[ENTITY_COMPONENT] ?? []) {
      if (!Number.isSafeInteger(e) || e < 1 || e >= nextEntity) {
        throw new TypeError(`WorldSnapshot: entity ${e} is outside 1..${nextEntity - 1}`);
      }
      alive.add(e);
    }
    const stores = new Map<string, Table<Entity>>();
    for (const name of Object.keys(components).sort(compareStrings)) {
      if (name === ENTITY_COMPONENT) continue;
      const table: Table<Entity> = new Map();
      for (const [e, v] of components[name]!) {
        if (!alive.has(e))
          throw new TypeError(`WorldSnapshot: component "${name}" on dead entity ${e}`);
        table.set(
          e,
          new Slot(
            cloneJson(v, () => `${name}[${e}]`),
            0,
          ),
        );
      }
      if (table.size > 0) stores.set(name, table);
    }
    const res: Table<string> = new Map();
    for (const key of Object.keys(resources).sort(compareStrings)) {
      res.set(
        key,
        new Slot(
          cloneJson(resources[key], () => `resource ${key}`),
          0,
        ),
      );
    }
    this.nextEntity = nextEntity;
    this.alive.clear();
    for (const e of alive) this.alive.add(e);
    this.stores = stores;
    this.byIndex = [];
    this.resources = res;
  }

  private assertAlive(e: Entity, op: string, name: string): void {
    if (!this.alive.has(e)) throw new Error(`world.${op}(${e}, "${name}"): entity does not exist`);
  }

  private assertNotReserved(name: string): void {
    if (name === ENTITY_COMPONENT)
      throw new Error(`Component "${ENTITY_COMPONENT}" is reserved by the kernel`);
  }
}

/** Empty ECS world. */
export function createWorld(): World {
  return new WorldImpl();
}

/** Rebuilds a world from snapshot(); round-trips exactly. */
export function restoreWorld(snapshot: WorldSnapshot): World {
  const w = new WorldImpl();
  w.load(snapshot);
  return w;
}
