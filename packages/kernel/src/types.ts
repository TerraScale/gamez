/**
 * Kernel contracts: "everything is a module" (plan §1).
 *
 * The kernel owns only mechanics: module loading, staged data registries,
 * a deterministic ECS world, systems/actions with override rules, a seeded
 * RNG and the scheduler. Every rule of every game mode lives in modules.
 *
 * Determinism (required so the same sim runs on client and server, §3):
 * - Sim code (data/setup/systems/actions) must not use Math.random, Date,
 *   performance.now, timers, I/O or iteration over unordered host objects.
 *   Use ctx.rng, ctx.tick/ctx.timeMs and ordered queries instead.
 * - Component and resource values are plain JSON data (no class instances,
 *   functions, Map/Set, undefined fields, NaN/Infinity).
 * - Every iteration the kernel exposes (registry.all, world.query) is sorted.
 */

// ---------------------------------------------------------------------------
// Data stage: registries (Factorio model: data -> dataUpdates -> dataFinal)
// ---------------------------------------------------------------------------

/** Prototype tables keyed by kind ("item", "spell", "creature", "class", ...). */
export interface Registry {
  /** Adds a prototype. Throws if (kind, id) already exists — use patch() to change another module's data. */
  define<T extends object>(kind: string, id: string, proto: T): void;
  /** Mutates or replaces an existing prototype. Throws if it does not exist. */
  patch<T extends object>(kind: string, id: string, fn: (proto: T) => T | void): void;
  /** Removes a prototype (e.g. a mode dropping a base item). No-op if absent. */
  remove(kind: string, id: string): void;
  has(kind: string, id: string): boolean;
  get<T extends object>(kind: string, id: string): T | undefined;
  /** All prototypes of a kind, sorted by id. */
  all<T extends object>(kind: string): ReadonlyArray<readonly [string, T]>;
}

/** Read-only registry after the data stages; prototypes are deep-frozen. */
export interface FrozenRegistry {
  has(kind: string, id: string): boolean;
  get<T extends object>(kind: string, id: string): Readonly<T> | undefined;
  /** Like get() but throws a descriptive error when missing. */
  require<T extends object>(kind: string, id: string): Readonly<T>;
  all<T extends object>(kind: string): ReadonlyArray<readonly [string, Readonly<T>]>;
  kinds(): string[];
  /** Stable hash of all prototypes (hex). Part of the mode's contentHash. */
  readonly hash: string;
}

// ---------------------------------------------------------------------------
// ECS world
// ---------------------------------------------------------------------------

export type Entity = number;

/** Typed component handle. Create with defineComponent(). Names are namespaced ("steps.position"). */
export interface ComponentType<T> {
  readonly name: string;
  /** Phantom field carrying the value type. */
  readonly __type?: T;
}

export interface World {
  /** Creates an entity. Ids are allocated monotonically and never reused within a world. */
  create(): Entity;
  destroy(e: Entity): void;
  exists(e: Entity): boolean;
  add<T>(e: Entity, c: ComponentType<T>, value: T): void;
  /** Shallow-merges into an existing component value (throws if absent). */
  update<T extends object>(e: Entity, c: ComponentType<T>, patch: Partial<T>): void;
  remove<T>(e: Entity, c: ComponentType<T>): void;
  has<T>(e: Entity, c: ComponentType<T>): boolean;
  get<T>(e: Entity, c: ComponentType<T>): T | undefined;
  /** Like get() but throws when the component is missing. */
  read<T>(e: Entity, c: ComponentType<T>): T;
  /** Entities having ALL given components, in ascending entity id order. */
  query(...cs: ComponentType<unknown>[]): Entity[];
  /** Singleton state keyed by name (e.g. "steps.floor"). */
  getResource<T>(key: string): T | undefined;
  setResource<T>(key: string, value: T): void;
  deleteResource(key: string): void;
  /** JSON-serialisable full state. */
  snapshot(): WorldSnapshot;
}

export interface WorldSnapshot {
  nextEntity: number;
  /** component name -> [entity, value][] sorted by entity */
  components: Record<string, [Entity, unknown][]>;
  /** sorted by key */
  resources: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runtime: RNG, context, systems, actions, events
// ---------------------------------------------------------------------------

/** Deterministic PRNG. State is plain data so it can be persisted and restored. */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates, returns a new array. */
  shuffle<T>(items: readonly T[]): T[];
  getState(): RngState;
  setState(s: RngState): void;
}

export type RngState = [number, number, number, number];

export interface GameEvent {
  /** Namespaced event type, e.g. "steps.attack". */
  type: string;
  [key: string]: unknown;
}

export interface SimContext {
  readonly mode: ModeSpec;
  readonly registry: FrozenRegistry;
  readonly rng: Rng;
  /** Ticks elapsed since the sim was created (fixed: real ticks; event: one per resolved action). */
  readonly tick: number;
  /** Sim time in ms = tick * (1000 / hz) for fixed modes; equals tick for event modes. */
  readonly timeMs: number;
  /** Player that issued the action being processed, if any. */
  readonly actor: string | null;
  /** Queues an event for observers (UI, network). Delivered after the action/tick completes. */
  emit(event: GameEvent): void;
}

export type SystemStage = "pre" | "update" | "post";

export interface SystemDef {
  /** Namespaced id, e.g. "steps.monsters.act". Must be unique in a mode. */
  id: string;
  /** Default "update". */
  stage?: SystemStage;
  /** Lower runs first within a stage (default 0). Ties: module load order, then id. */
  order?: number;
  run(world: World, ctx: SimContext): void;
}

/** Thrown by an action's parse/apply to reject it with a machine-readable code. */
export class ActionError extends Error {
  // A plain field, not a parameter property, so Node can strip this file's types (ADR 0002 §4).
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ActionError";
  }
}

export interface ActionDef<P = unknown> {
  /** Namespaced name, e.g. "steps.move". Must be unique in a mode. */
  name: string;
  /** Validates untrusted input and returns a typed payload. Throw ActionError to reject. */
  parse(world: World, payload: unknown, ctx: SimContext): P;
  /** Mutates the world. Throw ActionError to reject (the kernel rolls the world back). */
  apply(world: World, payload: P, ctx: SimContext): void;
}

/** How a module changes another module's runtime behaviour. Applied after all modules load, in load order. */
export type Override =
  | { kind: "system"; target: string; op: "disable" }
  | { kind: "system"; target: string; op: "replace"; with: SystemDef["run"] }
  | {
      kind: "system";
      target: string;
      op: "wrap";
      /** `next` runs the previous implementation. */
      with: (world: World, ctx: SimContext, next: () => void) => void;
    }
  | { kind: "action"; target: string; op: "disable" }
  | { kind: "action"; target: string; op: "replace"; with: ActionDef<any> }
  | {
      kind: "action";
      target: string;
      op: "wrap";
      /** Wraps apply(); `next` runs the previous apply with the given payload. */
      with: (world: World, payload: any, ctx: SimContext, next: (payload: any) => void) => void;
    };

// ---------------------------------------------------------------------------
// Modules and modes
// ---------------------------------------------------------------------------

export interface ModuleSpec {
  /** Namespaced id, e.g. "steps.combat". Globs in modes match on this. */
  id: string;
  version: string;
  /** Module ids that must load before this one (must be in the mode). */
  deps?: string[];
  /** Loaded before this one when present in the mode; ignored otherwise. */
  optionalDeps?: string[];
  data?(reg: Registry): void;
  dataUpdates?(reg: Registry): void;
  dataFinal?(reg: Registry): void;
  /** Initial world state for a new sim (runs in load order after the registry is frozen). */
  setup?(world: World, ctx: SimContext): void;
  systems?: SystemDef[];
  actions?: ActionDef<any>[];
  overrides?: Override[];
}

export type TickPolicy =
  /** Real-time: systems run every tick at `hz` (classic ARPG). */
  | { kind: "fixed"; hz: number }
  /** Turn/step based: systems run once after each successful action. */
  | { kind: "event" };

export interface ModeSpec {
  id: string;
  name: string;
  description: string;
  /** Persistent world id, or null for instance-only modes. */
  world: string | null;
  /** Module ids or globs ("steps.*", "base.*"). Order does not matter; deps decide load order. */
  modules: string[];
  tick: TickPolicy;
  /** Instance rules belong to the mode (party size etc.). */
  instance?: { maxPlayers: number };
}

/** Result of resolving and loading a mode. Immutable and shareable across sims. */
export interface LoadedMode {
  mode: ModeSpec;
  /** Resolved modules in load order (deps first; ties broken by id). */
  modules: ModuleSpec[];
  registry: FrozenRegistry;
  /** Effective systems after overrides, in execution order. */
  systems: SystemDef[];
  /** Effective actions after overrides, by name. */
  actions: ReadonlyMap<string, ActionDef<any>>;
  /** Hash of module ids+versions and the registry hash (hex). Clients and server must match. */
  contentHash: string;
}

export interface DispatchResult {
  ok: boolean;
  error?: { code: string; message: string };
  events: GameEvent[];
  tick: number;
}

/** A running simulation of one mode. */
export interface Sim {
  readonly loaded: LoadedMode;
  readonly world: World;
  readonly tick: number;
  /**
   * Validates and applies an action atomically: on any thrown error the world,
   * RNG and tick are restored and ok=false. Event modes then run all systems
   * once and advance the tick.
   */
  dispatch(name: string, payload: unknown, actor: string | null): DispatchResult;
  /** Fixed modes: runs `n` ticks of all systems. Throws for event modes. */
  step(n?: number): GameEvent[];
  snapshot(): SimSnapshot;
  /** Stable hash of snapshot() (hex). Used by determinism tests and verification. */
  hash(): string;
}

export interface SimSnapshot {
  modeId: string;
  contentHash: string;
  tick: number;
  rng: RngState;
  world: WorldSnapshot;
}

export interface CreateSimOptions {
  seed: number;
  /** Restore instead of running setup(). contentHash must match. */
  from?: SimSnapshot;
}
