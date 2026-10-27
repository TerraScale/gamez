import type {
  ComponentType,
  CreateSimOptions,
  LoadedMode,
  ModeSpec,
  ModuleSpec,
  Registry,
  Rng,
  Sim,
  World,
  WorldSnapshot,
} from "./types.ts";

/** Identity helpers that give modules and modes type checking. */
export function defineModule(spec: ModuleSpec): ModuleSpec {
  return spec;
}

export function defineMode(spec: ModeSpec): ModeSpec {
  return spec;
}

export function defineComponent<T>(name: string): ComponentType<T> {
  return { name } as ComponentType<T>;
}

// The functions below are implemented by the kernel (see their doc comments).

/** Mutable registry used during the data stages. */
export declare function createRegistry(): Registry & {
  freeze(): import("./types.ts").FrozenRegistry;
};

/** Empty ECS world. */
export declare function createWorld(): World;

/** Rebuilds a world from snapshot(); round-trips exactly. */
export declare function restoreWorld(snapshot: WorldSnapshot): World;

/** Seeded PRNG (sfc32 seeded via splitmix32 from `seed`). Same seed -> same sequence on every JS engine. */
export declare function createRng(seed: number): Rng;

/**
 * Canonical JSON (object keys sorted, arrays in order) hashed to 16 hex chars
 * (two independent 32-bit FNV-1a/murmur-style lanes). Throws on non-JSON values
 * (functions, undefined, NaN, Infinity, Map/Set, class instances).
 */
export declare function stableHash(value: unknown): string;

/** "steps.*" matches "steps.combat" and "steps.ai.basic"; "*" matches all; exact ids match themselves. */
export declare function matchGlob(pattern: string, id: string): boolean;

/**
 * Resolves `mode.modules` against `catalog`, orders them (deps/optionalDeps
 * first, ties by id), runs data -> dataUpdates -> dataFinal for every module
 * per stage, freezes the registry, collects systems/actions and applies
 * overrides in load order.
 *
 * Throws descriptive errors for: a pattern that matches nothing, duplicate
 * module ids in the catalog, a missing required dep, dependency cycles,
 * duplicate system ids or action names, and overrides targeting unknown ids.
 */
export declare function loadMode(mode: ModeSpec, catalog: readonly ModuleSpec[]): LoadedMode;

/** Creates a sim: runs every module's setup() (or restores `from`). */
export declare function createSim(loaded: LoadedMode, opts: CreateSimOptions): Sim;
