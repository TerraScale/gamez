/**
 * Deterministic ECS world: one sparse store per component name, monotonic
 * entity ids and sorted queries.
 *
 * Values passed to add()/setResource()/update() are deep-cloned, and
 * snapshot() returns deep clones, so callers can never alias internal state.
 * get()/read()/getResource() return the live stored value: mutating it in a
 * system or action is allowed and is covered by snapshots and rollback.
 */
import { cloneJson, compareStrings } from "./hash.ts";
import type { ComponentType, Entity, World, WorldSnapshot } from "./types.ts";

/**
 * Reserved component that marks live entities, so entities without any
 * other component survive snapshot/restore. Modules cannot add or remove it.
 */
export const ENTITY_COMPONENT = "kernel.entity";

const byEntity = (a: [Entity, unknown], b: [Entity, unknown]) => a[0] - b[0];

export class WorldImpl implements World {
  private nextEntity = 1;
  private readonly alive = new Set<Entity>();
  private stores = new Map<string, Map<Entity, unknown>>();
  private resources = new Map<string, unknown>();

  create(): Entity {
    const e = this.nextEntity++;
    this.alive.add(e);
    return e;
  }

  destroy(e: Entity): void {
    if (!this.alive.delete(e)) return;
    for (const store of this.stores.values()) store.delete(e);
  }

  exists(e: Entity): boolean {
    return this.alive.has(e);
  }

  add<T>(e: Entity, c: ComponentType<T>, value: T): void {
    this.assertAlive(e, "add", c.name);
    this.assertNotReserved(c.name);
    let store = this.stores.get(c.name);
    if (!store) {
      store = new Map();
      this.stores.set(c.name, store);
    }
    store.set(e, cloneJson(value, `${c.name}[${e}]`));
  }

  update<T extends object>(e: Entity, c: ComponentType<T>, patch: Partial<T>): void {
    const current = this.stores.get(c.name)?.get(e);
    if (current === undefined) {
      throw new Error(`world.update(${e}, "${c.name}"): entity has no such component`);
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new TypeError(`world.update(${e}, "${c.name}"): component value is not an object`);
    }
    const target = current as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (v === undefined) delete target[k];
      else target[k] = cloneJson(v, `${c.name}[${e}].${k}`);
    }
  }

  remove<T>(e: Entity, c: ComponentType<T>): void {
    this.assertNotReserved(c.name);
    this.stores.get(c.name)?.delete(e);
  }

  has<T>(e: Entity, c: ComponentType<T>): boolean {
    return c.name === ENTITY_COMPONENT
      ? this.alive.has(e)
      : (this.stores.get(c.name)?.has(e) ?? false);
  }

  get<T>(e: Entity, c: ComponentType<T>): T | undefined {
    if (c.name === ENTITY_COMPONENT) return (this.alive.has(e) ? true : undefined) as T | undefined;
    return this.stores.get(c.name)?.get(e) as T | undefined;
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
      const store = this.stores.get(c.name);
      if (!store || store.size === 0) return [];
      sets.push(store);
    }
    sets.sort((a, b) => a.size - b.size);
    const [smallest, ...rest] = sets as [(typeof sets)[number], ...typeof sets];
    const out: Entity[] = [];
    for (const e of smallest.keys()) {
      if (rest.every((s) => s.has(e))) out.push(e);
    }
    return out.sort((a, b) => a - b);
  }

  getResource<T>(key: string): T | undefined {
    return this.resources.get(key) as T | undefined;
  }

  setResource<T>(key: string, value: T): void {
    if (value === undefined)
      throw new TypeError(`world.setResource("${key}", undefined): use deleteResource()`);
    this.resources.set(key, cloneJson(value, `resource ${key}`));
  }

  deleteResource(key: string): void {
    this.resources.delete(key);
  }

  snapshot(): WorldSnapshot {
    const components: Record<string, [Entity, unknown][]> = {};
    if (this.alive.size > 0) {
      components[ENTITY_COMPONENT] = [...this.alive].sort((a, b) => a - b).map((e) => [e, true]);
    }
    for (const name of [...this.stores.keys()].sort(compareStrings)) {
      const store = this.stores.get(name)!;
      if (store.size === 0) continue;
      const rows: [Entity, unknown][] = [];
      for (const [e, v] of store) rows.push([e, cloneJson(v, `${name}[${e}]`)]);
      components[name] = rows.sort(byEntity);
    }
    const resources: Record<string, unknown> = {};
    for (const key of [...this.resources.keys()].sort(compareStrings)) {
      resources[key] = cloneJson(this.resources.get(key), `resource ${key}`);
    }
    return { nextEntity: this.nextEntity, components, resources };
  }

  /** Replaces this world's whole state with a snapshot (in place, so references to the world stay valid). */
  load(snapshot: WorldSnapshot): void {
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
    const stores = new Map<string, Map<Entity, unknown>>();
    for (const name of Object.keys(components).sort(compareStrings)) {
      if (name === ENTITY_COMPONENT) continue;
      const store = new Map<Entity, unknown>();
      for (const [e, v] of components[name]!) {
        if (!alive.has(e))
          throw new TypeError(`WorldSnapshot: component "${name}" on dead entity ${e}`);
        store.set(e, cloneJson(v, `${name}[${e}]`));
      }
      if (store.size > 0) stores.set(name, store);
    }
    const res = new Map<string, unknown>();
    for (const key of Object.keys(resources).sort(compareStrings)) {
      res.set(key, cloneJson(resources[key], `resource ${key}`));
    }
    this.nextEntity = nextEntity;
    this.alive.clear();
    for (const e of alive) this.alive.add(e);
    this.stores = stores;
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
