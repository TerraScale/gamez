/**
 * The simulation runner: setup, atomic action dispatch with rollback, the
 * tick policy (fixed or event) and state hashing.
 *
 * dispatch() and step() run as one world transaction (WorldImpl.begin()):
 * the world journals what they touch, and a throw rolls back the journal plus
 * the saved RNG state and tick. Rollback costs what the call touched, not the
 * size of the world.
 */
import { cloneJson, stableHash } from "./hash.ts";
import { createRng } from "./rng.ts";
import { ActionError } from "./types.ts";
import type {
  CreateSimOptions,
  DispatchResult,
  GameEvent,
  LoadedMode,
  Rng,
  RngState,
  Sim,
  SimContext,
  SimSnapshot,
  World,
} from "./types.ts";
import { WorldImpl } from "./world.ts";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Error raised inside a system; keeps the ActionError code when there is one. */
function systemError(id: string, err: unknown): Error {
  if (err instanceof ActionError) return err;
  return new Error(`System "${id}" failed: ${errorMessage(err)}`, { cause: err });
}

/** Non-world state saved at the start of a transaction. */
interface Saved {
  rng: RngState;
  tick: number;
}

class SimImpl implements Sim {
  readonly loaded: LoadedMode;
  readonly world: World;
  private readonly impl: WorldImpl;
  private readonly rng: Rng;
  private currentTick = 0;
  private actor: string | null = null;
  /** Event buffer of the running dispatch/step; null when idle. */
  private events: GameEvent[] | null = null;
  private readonly ctx: SimContext;
  private readonly msPerTick: number;

  constructor(loaded: LoadedMode, opts: CreateSimOptions) {
    this.loaded = loaded;
    this.impl = new WorldImpl();
    this.world = this.impl;
    this.rng = createRng(opts.seed);
    const tick = loaded.mode.tick;
    this.msPerTick = tick.kind === "fixed" ? 1000 / tick.hz : 1;
    const live = (get: () => unknown): PropertyDescriptor => ({ get, enumerable: true });
    this.ctx = Object.freeze(
      Object.defineProperties(
        {
          mode: loaded.mode,
          registry: loaded.registry,
          rng: this.rng,
          emit: (e: GameEvent) => this.emit(e),
        },
        {
          tick: live(() => this.currentTick),
          timeMs: live(() => this.currentTick * this.msPerTick),
          actor: live(() => this.actor),
        },
      ),
    ) as SimContext;

    if (opts.from) {
      this.restore(opts.from);
    } else {
      this.runSetup();
    }
  }

  get tick(): number {
    return this.currentTick;
  }

  dispatch(name: string, payload: unknown, actor: string | null): DispatchResult {
    this.assertIdle("dispatch");
    const action = this.loaded.actions.get(name);
    if (!action) {
      return {
        ok: false,
        error: {
          code: "unknown_action",
          message: `Unknown action "${name}" in mode "${this.loaded.mode.id}"`,
        },
        events: [],
        tick: this.currentTick,
      };
    }
    const saved = this.begin();
    const events: GameEvent[] = [];
    this.events = events;
    this.actor = actor;
    try {
      const parsed: unknown = action.parse(this.world, payload, this.ctx);
      action.apply(this.world, parsed, this.ctx);
      if (this.loaded.mode.tick.kind === "event") {
        this.runSystems();
        this.currentTick++;
      }
      this.impl.commit();
      return { ok: true, events, tick: this.currentTick };
    } catch (err) {
      this.rollback(saved);
      const code = err instanceof ActionError ? err.code : "internal";
      return {
        ok: false,
        error: { code, message: errorMessage(err) },
        events: [],
        tick: this.currentTick,
      };
    } finally {
      this.events = null;
      this.actor = null;
    }
  }

  step(n = 1): GameEvent[] {
    this.assertIdle("step");
    if (this.loaded.mode.tick.kind !== "fixed") {
      throw new Error(
        `Mode "${this.loaded.mode.id}" uses event ticks; step() is only for fixed modes`,
      );
    }
    if (!Number.isSafeInteger(n) || n < 0)
      throw new RangeError(`step(${n}): n must be a non-negative integer`);
    const saved = this.begin();
    const events: GameEvent[] = [];
    this.events = events;
    try {
      for (let i = 0; i < n; i++) {
        this.runSystems();
        this.currentTick++;
      }
      this.impl.commit();
      return events;
    } catch (err) {
      this.rollback(saved);
      throw err;
    } finally {
      this.events = null;
    }
  }

  snapshot(): SimSnapshot {
    return {
      modeId: this.loaded.mode.id,
      contentHash: this.loaded.contentHash,
      tick: this.currentTick,
      rng: this.rng.getState(),
      world: this.world.snapshot(),
    };
  }

  hash(): string {
    return stableHash(this.snapshot());
  }

  private runSetup(): void {
    this.events = [];
    try {
      for (const m of this.loaded.modules) {
        if (!m.setup) continue;
        try {
          m.setup(this.world, this.ctx);
        } catch (err) {
          throw new Error(`Module "${m.id}" failed in setup: ${errorMessage(err)}`, { cause: err });
        }
      }
    } finally {
      // Setup events have no observer yet.
      this.events = null;
    }
  }

  private restore(from: SimSnapshot): void {
    const { mode, contentHash } = this.loaded;
    if (from.modeId !== mode.id) {
      throw new Error(`Cannot restore a "${from.modeId}" snapshot into mode "${mode.id}"`);
    }
    if (from.contentHash !== contentHash) {
      throw new Error(
        `Snapshot contentHash ${from.contentHash} does not match mode "${mode.id}" contentHash ${contentHash}`,
      );
    }
    if (!Number.isSafeInteger(from.tick) || from.tick < 0)
      throw new TypeError(`Snapshot tick ${from.tick} is invalid`);
    this.impl.load(from.world);
    this.rng.setState(from.rng);
    this.currentTick = from.tick;
  }

  private runSystems(): void {
    for (const s of this.loaded.systems) {
      try {
        s.run(this.world, this.ctx);
      } catch (err) {
        throw systemError(s.id, err);
      }
    }
  }

  private emit(event: GameEvent): void {
    if (this.events === null)
      throw new Error("ctx.emit() called outside of setup, dispatch or step");
    if (
      typeof event !== "object" ||
      event === null ||
      typeof event.type !== "string" ||
      event.type === ""
    ) {
      throw new TypeError("ctx.emit(): event must be an object with a non-empty string type");
    }
    this.events.push(cloneJson(event, () => `event ${event.type}`));
  }

  /** Opens the world transaction and saves RNG and tick. */
  private begin(): Saved {
    const saved = { rng: this.rng.getState(), tick: this.currentTick };
    this.impl.begin();
    return saved;
  }

  /** Undoes everything since begin(). */
  private rollback(s: Saved): void {
    this.impl.rollback();
    this.rng.setState(s.rng);
    this.currentTick = s.tick;
  }

  private assertIdle(op: string): void {
    if (this.events !== null)
      throw new Error(`sim.${op}() cannot be called from inside a system, action or setup`);
  }
}

/** Creates a sim: runs every module's setup() (or restores `from`). */
export function createSim(loaded: LoadedMode, opts: CreateSimOptions): Sim {
  return new SimImpl(loaded, opts);
}
