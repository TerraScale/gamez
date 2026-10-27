# @gamez/kernel

The game kernel: "everything is a module" (plan §1). The kernel owns only mechanics: module loading, staged data registries, a deterministic ECS world, systems and actions with override rules, a seeded RNG and the scheduler. Every rule of every game mode lives in modules.

| File          | What                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| `types.ts`    | The contracts (`ModuleSpec`, `ModeSpec`, `World`, `Sim`, ...)                               |
| `api.ts`      | Public surface: `defineModule/Mode/Component` and re-exports of the implementations below   |
| `registry.ts` | `createRegistry()`: data-stage prototype tables, `freeze()` into a hashed `FrozenRegistry`  |
| `loader.ts`   | `loadMode()`, `matchGlob()`: resolution, ordering, data stages, systems, actions, overrides |
| `world.ts`    | `createWorld()`, `restoreWorld()`: the ECS world and its snapshots                          |
| `rng.ts`      | `createRng()`: sfc32 seeded by splitmix32                                                   |
| `sim.ts`      | `createSim()`: setup, atomic `dispatch()`, `step()`, `snapshot()`, `hash()`                 |
| `hash.ts`     | `stableHash()` and the canonical-JSON helpers                                               |

## Writing a module

```ts
import { ActionError, defineComponent, defineModule } from "@gamez/kernel";

export const Pos = defineComponent<{ x: number; y: number }>("steps.pos");
export const Hp = defineComponent<{ hp: number; max: number }>("steps.hp");

export default defineModule({
  id: "steps.combat", // namespaced; mode globs ("steps.*") match on it
  version: "1.0.0", // part of the mode's contentHash
  deps: ["steps.core"], // must be in the mode; loads first
  optionalDeps: ["steps.loot"], // loads first only if the mode has it

  // Data stages, run per stage across all modules in load order:
  // every data(), then every dataUpdates(), then every dataFinal().
  data: (reg) => reg.define("creature", "steps.mossling", { hp: 4, dmg: 1 }),
  dataUpdates: (reg) => reg.patch<{ hp: number }>("creature", "steps.rat", (p) => void (p.hp += 1)),

  // Initial world of a new sim, in load order, after the registry is frozen.
  setup(world, ctx) {
    const proto = ctx.registry.require<{ hp: number }>("creature", "steps.mossling");
    const e = world.create();
    world.add(e, Pos, { x: ctx.rng.int(0, 9), y: ctx.rng.int(0, 9) });
    world.add(e, Hp, { hp: proto.hp, max: proto.hp });
  },

  // Player input. parse() validates untrusted payloads; apply() mutates.
  // Throw ActionError(code, message) to reject: the kernel rolls everything back.
  actions: [
    {
      name: "steps.attack",
      parse(world, payload) {
        const target = (payload as { target?: unknown })?.target;
        if (typeof target !== "number" || !world.has(target, Hp)) {
          throw new ActionError("bad_target", "no such target");
        }
        return { target };
      },
      apply(world, { target }, ctx) {
        const hp = world.read(target, Hp);
        hp.hp -= 1; // values from get()/read() are live; mutating them is fine
        ctx.emit({ type: "steps.hit", target, hp: hp.hp });
      },
    },
  ],

  // Rules. Ordered by stage (pre, update, post), then order, then module
  // load order, then id.
  systems: [
    {
      id: "steps.combat.deaths",
      stage: "post",
      run: (world) => {
        /* ... */
      },
    },
  ],

  // Change other modules' behaviour, applied in load order after all modules load.
  overrides: [
    { kind: "system", target: "steps.core.regen", op: "disable" },
    { kind: "action", target: "steps.move", op: "wrap", with: (w, p, ctx, next) => next(p) },
  ],
});
```

Overrides:

- `disable` removes a system or action. Disabling twice is fine; wrapping or replacing a disabled target is a load error.
- `replace` swaps a system's `run`, or a whole action (its `name` must equal the target).
- `wrap` runs around the current implementation; `next` calls it. Wraps stack in load order, so a later module's wrap is outermost. An action wrap wraps `apply()` and may pass a different payload to `next`.
- An override whose target does not exist is a load error.

Load errors are thrown by `loadMode()` and name the modules involved: unmatched patterns, duplicate catalog ids, missing deps, dependency cycles (`a -> b -> a`), duplicate system ids or action names, unknown override targets.

## Writing a mode

```ts
import { createSim, defineMode, loadMode } from "@gamez/kernel";

export const stepsMode = defineMode({
  id: "steps",
  name: "Steps",
  description: "Step-based roguelike",
  world: null, // instance-only
  modules: ["steps.*"], // ids or globs; deps decide the load order
  tick: { kind: "event" }, // or { kind: "fixed", hz: 20 }
  instance: { maxPlayers: 1 },
});

const loaded = loadMode(stepsMode, MODULE_CATALOG); // immutable, share it across sims
const sim = createSim(loaded, { seed: 42 }); // or { seed, from: snapshot }
const res = sim.dispatch("steps.attack", { target: 3 }, "player-1");
// res = { ok, error?: { code, message }, events, tick }
```

- **Event modes** (`tick.kind: "event"`): each successful `dispatch()` applies the action, runs every system once and advances `tick` by one. `ctx.timeMs` equals `tick`.
- **Fixed modes**: `dispatch()` only applies the action; `step(n)` runs every system `n` times, advancing `tick` each time. `ctx.timeMs = tick * 1000 / hz`.
- `dispatch()` is atomic. On any throw from `parse`, `apply` or a system, world, RNG and tick are restored and `ok` is false. The code is the `ActionError` code, or `"internal"` for anything else; `"unknown_action"` means no such action is loaded. A failing `step(n)` restores the state from before the call and rethrows.
- `snapshot()` is plain JSON. `createSim(loaded, { seed, from })` resumes it exactly, but only when `from.contentHash` equals `loaded.contentHash` (module ids and versions plus the registry hash). Clients and the server must load the same modules.
- `hash()` is `stableHash(snapshot())`. Equal hashes mean identical state.

Rollback currently snapshots the whole world before each `dispatch()`/`step()` call. That is fine for the small test modes; large real-time worlds may need a journal later.

## Determinism rules

Sim code is everything the kernel runs: `data*`, `setup`, systems, actions and overrides. It runs on both client and server and must give the same result on every JS engine.

- No `Math.random`, `Date`, `performance`, `crypto`, timers (`setTimeout`, `setInterval`, ...) or I/O. Use `ctx.rng` for randomness and `ctx.tick` / `ctx.timeMs` for time. Lint enforces this for `packages/kernel/src/**` and `modules/*/src/**`, except `modules/*/src/client/**` and `*.tsx` (see the root `vite.config.ts`).
- Components, resources, prototypes and events are plain JSON data: no class instances, functions, `Map`/`Set`, `NaN`/`Infinity`. The kernel clones and validates them on the way in; object fields set to `undefined` are dropped.
- Never iterate unordered host state (object keys of untrusted data, `Map`s you built from hashing). Kernel iteration is always sorted: `registry.all()` by id, `world.query()` by entity id.
- Sort strings with plain `<` comparison, not `localeCompare` (locale dependent).
- Keep state in the world (components and resources). Module-level variables are shared between sims and are not snapshotted.
- Floats are deterministic in JS for `+ - * /` and `Math.floor/imul/...`, but `Math.sin/exp/pow` and friends may differ between engines. Prefer integer or fixed-point maths for anything that feeds back into the state.

The kernel tests in `tests/determinism.test.ts` check that same seed and same actions give the same `hash()`, that different seeds diverge, and that a restored snapshot continues exactly like an uninterrupted sim.

## Test

```sh
node_modules/.bin/vp test run packages/kernel   # from the repo root
```
