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
  /**
   * Read-only view of a component (undefined when absent). Same value as get(), but
   * it never logs a rollback copy, so hot read-only loops cost nothing extra inside a
   * transaction. NEVER mutate the result (not even later in the same call): use
   * get()/read() for values you change, or update().
   */
  peek<T>(e: Entity, c: ComponentType<T>): Readonly<T> | undefined;
  /** Entities having ALL given components, in ascending entity id order. */
  query(...cs: ComponentType<unknown>[]): Entity[];
  /** Singleton state keyed by name (e.g. "steps.floor"). */
  getResource<T>(key: string): T | undefined;
  /**
   * Read-only view of a resource (undefined when absent): like peek(), it never logs a
   * rollback copy. NEVER mutate the result; use getResource() for values you change.
   */
  peekResource<T>(key: string): Readonly<T> | undefined;
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
  instance?: {
    maxPlayers: number;
    /**
     * Wave B (docs/design/wave-B.md §2): the client runs this fixed-tick mode
     * locally and streams input segments; the InstanceDO replays and verifies
     * them instead of ticking the sim itself. Absent = server-ticked.
     */
    clientDriven?: ClientDrivenPolicy;
  };
}

/**
 * Verification rules of a client-driven fixed-tick mode (wave B §2). The
 * InstanceDO (VerifiedHost) stays generic: everything mode-specific is here.
 * Functions must be pure and deterministic (they run on the server only, but
 * read sim state). They are not part of contentHash.
 */
export interface ClientDrivenPolicy {
  /** Most ticks one segment may cover (segments above this are rejected as bad_segment). */
  maxTicksPerSegment: number;
  /** Most inputs (successful dispatches) one segment may carry. */
  maxInputsPerSegment: number;
  /**
   * Sim speed multiplier in effect for the next tick (>= 1). A tick costs
   * msPerTick / speedOf(world) of wall time in the anti speed-hack ledger.
   * Sampled at the start of a segment and after every input.
   */
  speedOf(world: World): number;
  /** Highest value speedOf may return; larger values are clamped (and logged). */
  maxSpeed: number;
  /** Actions only the server may dispatch; a segment containing one is rejected. */
  serverOnlyActions: readonly string[];
  /**
   * Offline progress (docs/design/offline-idle.md §5): after at least `minMs`
   * of server-measured absence the host dispatches `action` with
   * `payload(elapsedMs, tunables)` (default `{ elapsedMs }`), elapsedMs =
   * min(absence, capMs), when `eligible(world)` is true. Failures are logged
   * and ignored. `tunables` are the admin's live numeric config values
   * (ConfigResponse.tunables; `{}` when unavailable): the payload carries the
   * effective values so replay stays deterministic (the grant is compacted
   * at once and never replayed from a client).
   */
  offline?: {
    action: string;
    minMs: number;
    capMs: number;
    eligible(world: World): boolean;
    payload?(elapsedMs: number, tunables: Readonly<Record<string, number>>): unknown;
  };
  /**
   * Read-model rows derived from verified state (leaderboards, summaries).
   * The host calls it after persisting verified state and appends the rows
   * whose content changed to its outbox (docs/design/wave-B.md §4).
   */
  reports?(world: World, registry: FrozenRegistry): InstanceReport[];
  /**
   * Report tables whose rows `reports` returns as the complete set: a key the
   * host reported before that `reports` no longer returns (a dismissed party
   * member, a reset hero) is tombstoned in the read model. Tables not listed
   * keep their old rows (history that scrolls out of the world, e.g. old runs).
   */
  completeReportTables?: readonly string[];
  /** Wave C platform hooks (docs/design/wave-C.md §2): bank, arena builds, season progress. */
  platform?: PlatformHooks;
  /** Admin dashboard: how verified play folds into metrics (docs/design/admin-dashboard.md §5). */
  analytics?: ModeAnalytics;
}

/**
 * Adds `amount` to counter (metric, k1, k2). All three keys must have bounded
 * cardinality: enums, registry ids, bands ("10-19"). Never names or ids of players.
 */
export type AnalyticsTally = (metric: string, k1: string, k2: string, amount: number) => void;

/**
 * Admin dashboard hooks of a client-driven mode (docs/design/admin-dashboard.md §5).
 * Pure, server-side only, never part of contentHash; they read the world and
 * never change it. The verified host (analytics/sim-tally.ts) calls them for
 * verified segments and offline grants only.
 */
export interface ModeAnalytics {
  /**
   * Bounded dimensions of the hero now. `control` is the control mode
   * ("manual" | "auto" | "idle"), `levelBand` e.g. "10-19". The host tallies
   * ("play.ms", control, levelBand) (wall time = replay cost) and ("sim.ms", …)
   * for every verified segment itself.
   */
  dims(world: World): { control: string; levelBand: string };
  /** Folds one batch of verified events (and the world after them) into counters. */
  fold(events: readonly GameEvent[], world: World, tally: AnalyticsTally): void;
  /** Summary of one offline grant's events, or null when it granted nothing. */
  offline?(
    events: readonly GameEvent[],
    world: World,
  ): { kills: number; xp: number; gold: number; items: number; levels: number } | null;
}

/**
 * Wave C: how the verified host connects a client-driven mode to the account
 * economy, the arena and the battle pass. Everything stays plain JSON so the
 * kernel knows nothing about the economy; @gamez/protocol (economy.ts) types
 * the payloads (BankOp, VaultItemInput, ArenaBuild).
 */
export interface PlatformHooks {
  /**
   * Server-only action applying a bank operation (must also be listed in
   * serverOnlyActions). The host dispatches it with actor "server" and payload
   * { opId, op, item? } (item: the VaultItem taken from the account for
   * withdrawItem, coin for withdrawCoin is in op). It throws ActionError when
   * the op is impossible (not in town, no room, unknown ref) and on success
   * emits exactly one event of type `effectEvent` (see below).
   */
  bankAction: string;
  /**
   * Event type the bank action emits on success:
   * { type, opId, credit: { coin: number } | null, item: VaultItemInput | null,
   *   gold: number } — what the host must hand to the account (deposits) and
   * the gold moved, for the result.
   */
  bankEvent: string;
  /** Pure: the hero reduced to an arena build (plain JSON ArenaBuild without accountId/displayName/sourceHash), or null. */
  build?(world: World, registry: FrozenRegistry): Record<string, unknown> | null;
  /**
   * Pure: monotonic season progress of this hero. `key` identifies the hero
   * (classic: "classic:<worldSeed>") so a new hero starts a new counter; the
   * account adds max(0, total - lastTotal[key]) season xp. null = no hero.
   */
  seasonTotal?(world: World, registry: FrozenRegistry): { key: string; total: number } | null;
}

/** One read-model row produced by ClientDrivenPolicy.reports(). */
export interface InstanceReport {
  /** Outbox/projection table, e.g. "classic_hero". */
  table: string;
  /** Row key, unique per instance within `table`, e.g. "hero" or "run:12". */
  key: string;
  /** Plain JSON columns (the projection maps them to D1 columns). */
  data: Record<string, string | number | boolean | null>;
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
