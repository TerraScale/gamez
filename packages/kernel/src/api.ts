/**
 * Public kernel API. The helpers below are identity functions for type
 * checking; everything else is re-exported from its implementation file.
 */
import type { ComponentType, ModeSpec, ModuleSpec } from "./types.ts";
import { componentHandle } from "./world.ts";

/** Identity helpers that give modules and modes type checking. */
export function defineModule(spec: ModuleSpec): ModuleSpec {
  return spec;
}

export function defineMode(spec: ModeSpec): ModeSpec {
  return spec;
}

export function defineComponent<T>(name: string): ComponentType<T> {
  return componentHandle<T>(name);
}

/** Mutable registry used during the data stages (`freeze()` deep-freezes and hashes it). */
export { createRegistry } from "./registry.ts";
/** Empty ECS world, and rebuilding one from snapshot() (exact round trip). */
export { createWorld, restoreWorld } from "./world.ts";
/** Seeded PRNG (sfc32 seeded via splitmix32 from `seed`). Same seed -> same sequence on every JS engine. */
export { createRng } from "./rng.ts";
/** Canonical JSON hashed to 16 hex chars. Throws on non-JSON values. */
export { stableHash } from "./hash.ts";
/** Glob matching for mode module lists, and mode resolution/loading. */
export { loadMode, matchGlob } from "./loader.ts";
/** Creates a sim: runs every module's setup() (or restores `from`). */
export { createSim } from "./sim.ts";
/** Input segments of client-driven modes: recorder (client) and replay/verify (server). */
export {
  checkSegment,
  replaySegment,
  segmentKey,
  SegmentRecorder,
  type RecordedSegment,
  type ReplayErrorCode,
  type ReplayOptions,
  type ReplayOutcome,
  type SegmentBody,
  type SegmentInput,
} from "./replay.ts";
